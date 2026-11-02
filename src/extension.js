import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {deviceRows} from './devices.js';
import {Engine} from './engine.js';
import {ADMIN_CONSOLE_URL} from './errors.js';
import {CommandRunner} from './runner.js';
import {headerModel, identityLine, panelIconModel, sectionsOf} from './status.js';
import {relativeTime} from './time.js';
import {buildWarnings} from './warnings.js';

// Text and badge colours, readable on the dark and on the light Shell theme.
const PALETTES = {
    dark: {warning: '#f6d32d', error: '#ff7b63'},
    light: {warning: '#9c6e03', error: '#c01c28'},
};
const DIM_OPACITY = 170;
const OUTLINE_DIM_OPACITY = 115;
const TITLE_STYLE = 'font-weight: bold;';

/** Dims text with opacity: the Shell theme has no `dim-label` class. */
function dimLabel(text, params = {}) {
    return new St.Label({text, opacity: DIM_OPACITY, y_align: Clutter.ActorAlign.CENTER, ...params});
}

/** A label that wraps instead of ellipsizing, which would silently disable `line_wrap`. */
function wrapLabel(text, params = {}) {
    const label = new St.Label({text, x_expand: true, ...params});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return label;
}

/** A row that shows text and cannot be activated, hovered, or focused. */
function staticItem() {
    return new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
}

function copyIcon() {
    return new St.Icon({
        icon_name: 'edit-copy-symbolic',
        style_class: 'popup-menu-icon',
        opacity: DIM_OPACITY,
    });
}

/** Shows the state label of the header in its colour, or dimmed when it has none. */
function setStateText(label, text, color) {
    label.text = text;
    label.style = `font-size: 0.9em;${color ? ` color: ${color};` : ''}`;
    label.opacity = color ? 255 : DIM_OPACITY;
}

/**
 * A row that runs its action and leaves the menu open. The menu closes on the `activate` signal
 * of any of its items, so this row calls its handler directly and never emits it.
 */
const KeepOpenMenuItem = GObject.registerClass(
    class KeepOpenMenuItem extends PopupMenu.PopupBaseMenuItem {
        onActivate(handler) {
            this._handler = handler;
        }

        activate(event) {
            this._handler?.(event);
        }
    });

/**
 * The header row with a switch: the title, the state label, and the switch. Activating the row
 * toggles the switch without closing the menu, which PopupSwitchMenuItem.activate() would do
 * through its parent. setToggleState() emits `toggled` like a click does, so callers wrap
 * their updates.
 */
const HeaderItem = GObject.registerClass(
    class HeaderItem extends PopupMenu.PopupSwitchMenuItem {
        constructor() {
            super('Tailscale', false);
            this.label.x_expand = true;
            this.label.add_style_class_name('tailtray-title');
            this.label.style = 'font-weight: bold;';
            this.stateLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, style: 'font-size: 0.9em;'});
            this.insert_child_above(this.stateLabel, this.label);
        }

        activate(_event) {
            if (this._switch.mapped)
                this.toggle();
        }

        /** Shows the label in its colour, or dimmed when it has none. */
        setStateText(text, color) {
            this.stateLabel.text = text;
            this.stateLabel.style = `font-size: 0.9em;${color ? ` color: ${color};` : ''}`;
            this.stateLabel.opacity = color ? 255 : DIM_OPACITY;
        }

        setSwitchVisible(visible) {
            this._statusBin.visible = visible;
        }
    });

export default class TailtrayExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._runner = new CommandRunner();
        this._rendering = false;
        this._warningsKey = null;
        this._errorKey = null;
        this._schemeId = 0;
        this._dark = true;
        this._palette = PALETTES.dark;
        this._engine = new Engine({
            run: (args, timeoutSeconds) => this._runner.run(args, timeoutSeconds),
            setTimer: (milliseconds, callback) => GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, milliseconds, () => {
                    callback();
                    return GLib.SOURCE_REMOVE;
                }),
            clearTimer: id => GLib.Source.remove(id),
            now: () => Date.now(),
            intervalSeconds: () => this._settings.get_uint('refresh-interval'),
            userName: GLib.get_user_name(),
            onChange: model => this._render(model),
        });

        this._buildIndicator();
        this._buildMenu();
        // The Shell theme follows the colour scheme, and the colours above follow the theme.
        this._schemeId = St.Settings.get().connect('notify::color-scheme', () => {
            this._render(this._engine.model);
        });
        this._render(this._engine.model);
        this._engine.start();
    }

    disable() {
        // Destroying the engine turns every reply still in flight into a no-op, and the runner
        // kills the processes themselves.
        if (this._schemeId)
            St.Settings.get().disconnect(this._schemeId);
        this._schemeId = 0;
        this._engine?.destroy();
        this._runner?.destroy();
        this._indicator?.destroy();

        this._engine = null;
        this._runner = null;
        this._settings = null;
        this._indicator = null;
        this._icon = null;
        this._badge = null;
        this._header = null;
        this._staticHeader = null;
        this._staticStateLabel = null;
        this._identityItem = null;
        this._identityLabel = null;
        this._loginHelp = null;
        this._approvalHelp = null;
        this._errorSection = null;
        this._warningLine = null;
        this._warningLabel = null;
        this._warningsMenu = null;
        this._deviceCaption = null;
        this._deviceItems = null;
        this._separators = null;
        this._refreshItem = null;
        this._updatedLabel = null;
        this._preferencesItem = null;
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'Tailtray', false);
        const box = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._icon = new St.Icon({icon_size: 16, style_class: 'system-status-icon'});
        // The dot is drawn over the corner, not part of the symbolic glyph, whose colour the theme
        // sets.
        this._badge = new St.Widget({
            visible: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        box.add_child(this._icon);
        box.add_child(this._badge);
        this._indicator.add_child(box);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (!this._engine)
                return;
            if (open) {
                // Relative times are stale after a while closed.
                this._render(this._engine.model);
                this._engine.requestRefresh();
            } else {
                this._engine.menuClosed();
            }
        });
    }

    _buildMenu() {
        const menu = this._indicator.menu;

        this._header = new HeaderItem();
        this._header.connect('toggled', (_item, active) => {
            if (this._rendering)
                return;
            const command = active ? 'up' : 'down';
            this._engine.runAction(command, [command]);
        });
        menu.addMenuItem(this._header);
        // The states without a switch show the same row as plain text: a row that is not
        // activatable, so it neither dims nor highlights.
        this._staticHeader = staticItem();
        this._staticHeader.add_child(new St.Label({
            text: 'Tailscale',
            style: TITLE_STYLE,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._staticStateLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._staticHeader.add_child(this._staticStateLabel);
        menu.addMenuItem(this._staticHeader);

        this._identityItem = staticItem();
        this._identityLabel = dimLabel('', {x_expand: true});
        this._identityItem.add_child(this._identityLabel);
        menu.addMenuItem(this._identityItem);

        this._loginHelp = new PopupMenu.PopupMenuSection();
        const loginText = staticItem();
        loginText.add_child(wrapLabel('Log in from a terminal:'));
        this._loginHelp.addMenuItem(loginText);
        this._loginHelp.addMenuItem(this._copyRow('tailscale up', true));
        menu.addMenuItem(this._loginHelp);

        this._approvalHelp = new PopupMenu.PopupMenuSection();
        const approvalText = staticItem();
        approvalText.add_child(wrapLabel('An admin must approve this device.'));
        this._approvalHelp.addMenuItem(approvalText);
        this._approvalHelp.addMenuItem(this._linkRow('Open admin console', ADMIN_CONSOLE_URL));
        menu.addMenuItem(this._approvalHelp);

        this._errorSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._errorSection);

        this._warningLine = staticItem();
        this._warningLabel = wrapLabel('');
        this._warningLine.add_child(this._warningLabel);
        menu.addMenuItem(this._warningLine);
        this._warningsMenu = new PopupMenu.PopupSubMenuMenuItem('Warnings');
        menu.addMenuItem(this._warningsMenu);

        // Separators: after the top group when This device follows, and before the footer.
        this._separators = {
            top: new PopupMenu.PopupSeparatorMenuItem(),
            footer: new PopupMenu.PopupSeparatorMenuItem(),
        };
        menu.addMenuItem(this._separators.top);

        this._deviceCaption = staticItem();
        this._deviceCaption.add_child(dimLabel('This device', {x_expand: true}));
        menu.addMenuItem(this._deviceCaption);
        this._deviceItems = {};
        for (const id of ['dns', 'ipv4', 'ipv6']) {
            this._deviceItems[id] = this._copyRow('');
            menu.addMenuItem(this._deviceItems[id]);
        }

        menu.addMenuItem(this._separators.footer);

        this._refreshItem = new KeepOpenMenuItem();
        this._refreshItem.add_child(new St.Label({
            text: 'Refresh now',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._updatedLabel = dimLabel('', {visible: false});
        this._refreshItem.add_child(this._updatedLabel);
        this._refreshItem.onActivate(() => this._engine.requestRefresh());
        menu.addMenuItem(this._refreshItem);

        this._preferencesItem = new PopupMenu.PopupMenuItem('Preferences');
        this._preferencesItem.connect('activate', () => this.openPreferences());
        menu.addMenuItem(this._preferencesItem);
    }

    /** A row that shows a value with a copy icon; activating it copies the value. */
    _copyRow(value, monospace = false) {
        const item = new PopupMenu.PopupBaseMenuItem();
        item.valueLabel = new St.Label({
            text: value,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: monospace ? 'font-family: monospace;' : null,
        });
        item.add_child(item.valueLabel);
        item.add_child(copyIcon());
        item.connect('activate', () => this._copy(item.valueLabel.text));
        return item;
    }

    /** A row that opens an https URL. */
    _linkRow(text, url) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.connect('activate', () => this._openUrl(url));
        return item;
    }

    /** Puts a value in the clipboard, closes the menu, and shows it in the Shell's OSD. */
    _copy(value) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, value);
        this._indicator.menu.close();
        Main.osdWindowManager.showOne(
            global.display.get_current_monitor(),
            Gio.ThemedIcon.new('edit-copy-symbolic'),
            `Copied ${value}`
        );
    }

    /** Only https URLs are opened. */
    _openUrl(url) {
        if (!url.startsWith('https://'))
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
        } catch (error) {
            // No handler for https: there is nothing to show but the log.
            console.error(`Tailtray: could not open ${url}: ${error.message}`);
        }
    }

    _render(model) {
        if (!this._indicator)
            return;
        const sections = sectionsOf(model.state);
        const status = model.status;
        const now = Date.now();
        this._dark = St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;
        this._palette = this._dark ? PALETTES.dark : PALETTES.light;

        const header = headerModel(model.state, model.pending, model.loaded);
        this._renderPanel(model, header.label);
        this._renderHeader(header);

        const identity = sections.identity ? identityLine(status) : '';
        this._identityLabel.text = identity;
        this._identityItem.visible = identity !== '';

        this._loginHelp.actor.visible = sections.loginHelp;
        this._approvalHelp.actor.visible = sections.approvalHelp;
        const error = this._shownError(model, sections);
        this._renderError(error);
        const warnings = sections.warnings ? buildWarnings(status, now) : [];
        this._renderWarnings(warnings);

        const rows = sections.thisDevice ? deviceRows(status?.Self) : [];
        const shown = Object.fromEntries(rows.map(row => [row.id, row.value]));
        for (const [id, item] of Object.entries(this._deviceItems)) {
            item.visible = id in shown;
            if (id in shown)
                item.valueLabel.text = shown[id];
        }
        this._deviceCaption.visible = rows.length > 0;

        const topShown = identity !== '' || sections.loginHelp || sections.approvalHelp ||
            error !== null || warnings.length > 0;
        this._separators.top.visible = topShown && rows.length > 0;

        const updated = model.updatedAt === null
            ? '' : relativeTime(new Date(model.updatedAt).toISOString(), now);
        this._updatedLabel.text = updated === '' ? '' : `updated ${updated}`;
        this._updatedLabel.visible = updated !== '';
    }

    _renderPanel(model, headerLabel) {
        const icon = panelIconModel(model.state, headerLabel);
        const file = icon.glyph === 'filled' ? 'tailtray-symbolic.svg' : 'tailtray-outline-symbolic.svg';
        this._icon.gicon = Gio.FileIcon.new(this.dir.get_child(file));
        this._icon.opacity = icon.dimmed ? OUTLINE_DIM_OPACITY : 255;
        this._badge.visible = icon.badge !== null;
        if (icon.badge) {
            this._badge.style = `background-color: ${this._palette[icon.badge]}; border-radius: 4px; ` +
                'width: 7px; height: 7px;';
        }
        this._indicator.accessible_name = icon.name;
        this._icon.accessible_name = icon.name;
    }

    _renderHeader(header) {
        const color = header.labelColor ? this._palette[header.labelColor] : null;
        const hasSwitch = header.switchOn !== null;
        this._header.visible = hasSwitch;
        this._staticHeader.visible = !hasSwitch;
        setStateText(this._staticStateLabel, header.label, color);
        if (!hasSwitch)
            return;
        // Updating the switch from a refresh must not look like the user's toggle.
        this._rendering = true;
        setStateText(this._header.stateLabel, header.label, color);
        this._header.setToggleState(header.switchOn);
        this._header.setSensitive(header.switchSensitive);
        this._header.accessible_name = `Tailscale: ${header.label}`;
        this._rendering = false;
    }

    // The error under the header: a failed action's, or in Unavailable the refresh's.
    _shownError(model, sections) {
        if (!sections.errorBlock)
            return null;
        return model.state.id === 'unavailable' ? model.refreshError : model.actionError;
    }

    _renderError(error) {
        const key = JSON.stringify([this._dark, error]);
        if (key === this._errorKey)
            return;
        this._errorKey = key;
        this._errorSection.removeAll();
        if (!error)
            return;
        const text = staticItem();
        text.add_child(wrapLabel(error.text, {style: `color: ${this._palette.error};`}));
        this._errorSection.addMenuItem(text);
        if (error.command)
            this._errorSection.addMenuItem(this._copyRow(error.command, true));
        if (error.link)
            this._errorSection.addMenuItem(this._linkRow(error.link.label, error.link.url));
    }

    // One warning is a line under the identity; two or more fold into a submenu that keeps its
    // open state across refreshes.
    _renderWarnings(warnings) {
        this._warningLine.visible = warnings.length === 1;
        this._warningsMenu.visible = warnings.length > 1;
        const warningStyle = `color: ${this._palette.warning};`;
        this._warningLabel.style = warningStyle;
        this._warningsMenu.label.style = warningStyle;
        const key = JSON.stringify(warnings);
        if (key === this._warningsKey)
            return;
        this._warningsKey = key;
        if (warnings.length === 1)
            this._warningLabel.text = warnings[0];
        this._warningsMenu.menu.removeAll();
        if (warnings.length < 2)
            return;
        this._warningsMenu.label.text = `Warnings (${warnings.length})`;
        for (const warning of warnings) {
            const item = staticItem();
            item.add_child(wrapLabel(warning));
            this._warningsMenu.menu.addMenuItem(item);
        }
    }
}
