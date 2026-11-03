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

import {accountRows, currentTailnet} from './accounts.js';
import {deviceList, deviceRows} from './devices.js';
import {Engine} from './engine.js';
import {ADMIN_CONSOLE_URL} from './errors.js';
import {exitNodeArguments, exitNodeInUse, exitNodeRows} from './exitnodes.js';
import {Pinger} from './ping.js';
import {CommandRunner} from './runner.js';
import {LAN_ACCESS, setArguments, settingRows, SETTINGS, switchRow} from './settings.js';
import {headerModel, identityLine, panelIconModel, sectionsOf, separatorsOf} from './status.js';
import {relativeTime} from './time.js';
import {buildWarnings} from './warnings.js';

// Text and badge colours, readable on the dark and on the light Shell theme.
const PALETTES = {
    dark: {warning: '#f6d32d', error: '#ff7b63', online: '#57e389', offline: '#77767b'},
    light: {warning: '#9c6e03', error: '#c01c28', online: '#26a269', offline: '#9a9996'},
};
// The Exit node submenu is at most 280 px high and scrolls past that. The theme adds 8 px of
// border and padding to the content's max-height, so the content stops 8 px short of it.
const SUBMENU_HEIGHT = 280;
const SUBMENU_CHROME = 8;
// The Other devices list is at most 280 px high and scrolls past that.
const DEVICES_HEIGHT = 280;
const DIM_OPACITY = 170;
const OUTLINE_DIM_OPACITY = 115;
const GLYPH_FILES = {
    filled: 'tailtray-symbolic.svg',
    exit: 'tailtray-exit-symbolic.svg',
    outline: 'tailtray-outline-symbolic.svg',
};
// The rows under an expanded device are indented like the rows of a submenu.
const DEVICE_BODY_STYLE = 'padding-left: 2.2em;';
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
 * Shows a value on the right of a submenu row, before its arrow, and returns its label.
 */
function addSubmenuValue(submenuItem) {
    const label = dimLabel('', {x_expand: true, x_align: Clutter.ActorAlign.END});
    // The arrow no longer takes the free space, so the value sits right before it.
    submenuItem._triangleBin.x_expand = false;
    submenuItem.insert_child_below(label, submenuItem._triangleBin);
    return label;
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
            if (this.reactive)
                this._handler?.(event);
        }
    });

/**
 * A switch row of a submenu. Activating it toggles the switch without closing the menu, which
 * PopupSwitchMenuItem.activate() would do through its parent. setToggleState() emits `toggled`
 * like a click does, so callers wrap their updates.
 */
const SettingItem = GObject.registerClass(
    class SettingItem extends PopupMenu.PopupSwitchMenuItem {
        activate(_event) {
            if (this.reactive)
                this.toggle();
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
            if (this.reactive && this._switch.mapped)
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
        this._openDevice = null;
        this._pinger = new Pinger({
            start: (args, timeoutSeconds) => this._runner.start(args, timeoutSeconds),
            onChange: () => this._render(this._engine.model),
        });
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
        this._pinger?.destroy();
        this._runner?.destroy();
        this._indicator?.destroy();

        this._engine = null;
        this._pinger = null;
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
        this._devicesCaption = null;
        this._devicesCaptionLabel = null;
        this._devicesList = null;
        this._devicesScroll = null;
        this._devicesSection = null;
        this._deviceEntries = null;
        this._openDevice = null;
        this._accountMenu = null;
        this._accountTailnet = null;
        this._accountKey = null;
        this._accountItems = null;
        this._exitMenu = null;
        this._exitSummary = null;
        this._exitNone = null;
        this._exitItems = null;
        this._lanItem = null;
        this._settingsMenu = null;
        this._settingItems = null;
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
                this._engine.menuOpened();
                this._engine.requestRefresh();
            } else {
                this._engine.menuClosed();
                // A ping result lives until the menu closes, and a ping still running is killed.
                this._pinger.reset();
                this._openDevice = null;
                this._render(this._engine.model);
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

        // Separators: after the top group, after This device, and before the footer.
        this._separators = {
            top: new PopupMenu.PopupSeparatorMenuItem(),
            device: new PopupMenu.PopupSeparatorMenuItem(),
            controls: new PopupMenu.PopupSeparatorMenuItem(),
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

        menu.addMenuItem(this._separators.device);

        this._accountMenu = new PopupMenu.PopupSubMenuMenuItem('Account');
        this._accountTailnet = addSubmenuValue(this._accountMenu);
        this._accountItems = new Map();
        menu.addMenuItem(this._accountMenu);

        this._buildExitNodeMenu();
        menu.addMenuItem(this._exitMenu);

        this._settingsMenu = new PopupMenu.PopupSubMenuMenuItem('Settings');
        this._settingItems = {};
        for (const {id, label} of SETTINGS) {
            this._settingItems[id] = this._settingItem(id, label);
            this._settingsMenu.menu.addMenuItem(this._settingItems[id]);
        }
        menu.addMenuItem(this._settingsMenu);

        menu.addMenuItem(this._separators.controls);
        this._buildDevices(menu);

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

    /**
     * The Other devices section: a caption, then a scrolling list of device rows, each of which
     * expands in place. GNOME Shell cannot nest a submenu inside another, so the list lives in
     * the main menu, in a scroll view of its own.
     */
    _buildDevices(menu) {
        this._devicesCaption = staticItem();
        this._devicesCaptionLabel = dimLabel('', {x_expand: true});
        this._devicesCaption.add_child(this._devicesCaptionLabel);
        menu.addMenuItem(this._devicesCaption);

        this._devicesList = new PopupMenu.PopupMenuSection();
        this._devicesScroll = new St.ScrollView({
            style: `max-height: ${DEVICES_HEIGHT}px;`,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._devicesScroll.add_child(this._devicesList.actor);
        this._devicesSection = new PopupMenu.PopupMenuSection();
        this._devicesSection.actor.add_child(this._devicesScroll);
        menu.addMenuItem(this._devicesSection);
        this._deviceEntries = new Map();
    }

    /**
     * A device: its row (dot, name, OS or last seen, arrow) and, under it while expanded, the
     * copyable name and addresses and a Ping row.
     */
    _deviceEntry(id) {
        const row = new KeepOpenMenuItem();
        row.dot = new St.Widget({y_align: Clutter.ActorAlign.CENTER});
        row.add_child(row.dot);
        row.nameLabel = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        row.add_child(row.nameLabel);
        row.detailLabel = dimLabel('');
        row.add_child(row.detailLabel);
        row.arrow = new St.Icon({
            icon_name: 'pan-end-symbolic',
            style_class: 'popup-menu-icon',
            style: 'margin-left: 8px;',
        });
        row.add_child(row.arrow);

        const body = new PopupMenu.PopupMenuSection();
        body.actor.visible = false;
        const entry = {id, row, body, address: '', look: null, copy: {}};
        for (const copyId of ['dns', 'ipv4', 'ipv6']) {
            entry.copy[copyId] = this._copyRow('');
            entry.copy[copyId].style = DEVICE_BODY_STYLE;
            body.addMenuItem(entry.copy[copyId]);
        }
        entry.ping = new KeepOpenMenuItem();
        entry.ping.style = DEVICE_BODY_STYLE;
        entry.ping.add_child(new St.Label({text: 'Ping', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        entry.ping.resultLabel = dimLabel('', {visible: false});
        entry.ping.add_child(entry.ping.resultLabel);
        body.addMenuItem(entry.ping);

        entry.section = new PopupMenu.PopupMenuSection();
        entry.section.addMenuItem(row);
        entry.section.addMenuItem(body);
        // Expanding a device collapses the one that was open.
        row.onActivate(() => {
            this._openDevice = this._openDevice === id ? null : id;
            this._renderDeviceOpen();
        });
        entry.ping.onActivate(() => this._pinger.ping(id, entry.address));
        return entry;
    }

    _renderDeviceOpen() {
        for (const entry of this._deviceEntries.values()) {
            const open = entry.id === this._openDevice;
            entry.body.actor.visible = open;
            entry.row.arrow.icon_name = open ? 'pan-down-symbolic' : 'pan-end-symbolic';
        }
    }

    _renderDevices(model, shown) {
        const now = Date.now();
        const list = shown ? deviceList(model.status, now) : {caption: '', devices: []};
        this._devicesCaption.visible = shown;
        this._devicesCaptionLabel.text = list.caption;
        this._devicesSection.actor.visible = list.devices.length > 0;

        // Devices are kept by ID, so a refresh updates them in place: an expanded device stays
        // expanded and keeps its ping result, and the scroll position stays.
        const wanted = new Set(list.devices.map(device => device.id));
        for (const [id, entry] of this._deviceEntries) {
            if (wanted.has(id))
                continue;
            this._pinger.forget(id);
            entry.section.destroy();
            this._deviceEntries.delete(id);
            if (this._openDevice === id)
                this._openDevice = null;
        }
        list.devices.forEach((device, index) => {
            let entry = this._deviceEntries.get(device.id);
            if (!entry) {
                entry = this._deviceEntry(device.id);
                this._deviceEntries.set(device.id, entry);
                this._devicesList.addMenuItem(entry.section, index);
            }
            this._updateDevice(entry, device);
        });
        const current = this._devicesList._getMenuItems();
        const order = list.devices.map(device => this._deviceEntries.get(device.id).section);
        if (current.some((item, index) => item !== order[index]))
            order.forEach((item, index) => this._devicesList.moveMenuItem(item, index));
        this._renderDeviceOpen();
    }

    _updateDevice(entry, device) {
        const {row} = entry;
        const look = JSON.stringify([device.name, device.online, device.detail, this._dark]);
        if (look !== entry.look) {
            entry.look = look;
            row.nameLabel.text = device.name;
            row.nameLabel.opacity = device.online ? 255 : DIM_OPACITY;
            row.detailLabel.text = device.detail;
            row.dot.style = 'width: 8px; height: 8px; border-radius: 4px; margin-right: 8px; ' +
                `background-color: ${this._palette[device.online ? 'online' : 'offline']};`;
        }
        const values = Object.fromEntries(device.rows.map(copy => [copy.id, copy.value]));
        for (const [id, item] of Object.entries(entry.copy)) {
            item.visible = id in values;
            if (id in values)
                item.valueLabel.text = values[id];
        }
        entry.address = device.address;
        entry.ping.setSensitive(device.canPing);
        const result = this._pinger.text(device.id);
        entry.ping.resultLabel.text = result;
        entry.ping.resultLabel.visible = result !== '';
    }

    /** A switch row of a preference: toggling it runs `tailscale set --<id>=<value>`. */
    _settingItem(id, label) {
        const item = new SettingItem(label, false);
        item.connect('toggled', (_item, active) => {
            if (this._rendering)
                return;
            const detail = {flag: id, value: active};
            const started = this._engine.runAction('set', setArguments(id, active), detail);
            // Refused while another action runs: the switch goes back to what the model says.
            if (!started)
                this._render(this._engine.model);
        });
        return item;
    }

    /**
     * The Exit node submenu: None, one row per exit node (added and kept by peer ID as the
     * statuses come in), then Allow LAN access. It scrolls past SUBMENU_HEIGHT.
     */
    _buildExitNodeMenu() {
        this._exitMenu = new PopupMenu.PopupSubMenuMenuItem('Exit node');
        this._exitSummary = addSubmenuValue(this._exitMenu);
        const menu = this._exitMenu.menu;
        menu.actor.style = `max-height: ${SUBMENU_HEIGHT - SUBMENU_CHROME}px;`;
        menu.actor.vscrollbar_policy = St.PolicyType.AUTOMATIC;
        // open() resets the policy to NEVER unless the main menu itself needs a scrollbar, which
        // lets the rows grow past the cap on a tall screen: always scroll.
        menu._needsScrollbar = () => true;

        this._exitNone = this._exitNodeItem('None');
        this._exitNone.onActivate(() => {
            if (!this._exitNone.exitChecked)
                this._engine.runAction('exit', exitNodeArguments(''), {target: ''});
        });
        menu.addMenuItem(this._exitNone);
        this._exitItems = new Map();
        this._lanItem = this._settingItem(LAN_ACCESS.id, LAN_ACCESS.label);
        menu.addMenuItem(this._lanItem);
    }

    /** An exit node row: check mark, dot, name, offline badge, and progress. */
    _exitNodeItem(name, hasDot = false) {
        const item = new KeepOpenMenuItem();
        item.dot = null;
        if (hasDot) {
            item.dot = new St.Widget({y_align: Clutter.ActorAlign.CENTER});
            item.add_child(item.dot);
        }
        item.nameLabel = new St.Label({text: name, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        item.add_child(item.nameLabel);
        item.badge = new St.Label({
            text: 'offline',
            visible: false,
            opacity: DIM_OPACITY,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 0.8em; padding: 1px 7px; border-radius: 8px; ' +
                'background-color: rgba(128, 128, 128, 0.3);',
        });
        item.add_child(item.badge);
        item.progressLabel = dimLabel('', {visible: false});
        item.add_child(item.progressLabel);
        item.exitChecked = false;
        return item;
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

        // The profiles are listed once the first refresh answered, as the engine does.
        const accountShown = sections.account && model.loaded;
        this._renderAccount(model, accountShown);
        this._renderExitNode(model, sections.exitNode);
        this._renderSettings(model, sections.settings);
        this._renderDevices(model, sections.devices);

        const separators = separatorsOf({
            device: rows.length > 0,
            controls: accountShown || sections.settings,
            devices: sections.devices,
        });
        this._separators.top.visible = separators.top;
        this._separators.device.visible = separators.device;
        this._separators.controls.visible = separators.controls;
        this._separators.footer.visible = separators.footer;

        const updated = model.updatedAt === null
            ? '' : relativeTime(new Date(model.updatedAt).toISOString(), now);
        this._updatedLabel.text = updated === '' ? '' : `updated ${updated}`;
        this._updatedLabel.visible = updated !== '';
    }

    _renderAccount(model, shown) {
        this._accountMenu.visible = shown;
        // The expanded rows are not part of the heading: they go away with the section.
        if (!shown)
            this._accountMenu.menu.close(false);
        this._accountTailnet.text = currentTailnet(model.status, model.accounts.profiles);
        const menu = this._accountMenu.menu;
        const rows = accountRows(model.accounts, model.pending);

        // Rows are rebuilt only when their content changed, so an open submenu stays open and a
        // pending switch updates the row in place.
        const key = JSON.stringify(
            rows.message ?? rows.profiles.map(row => [row.id, row.title, row.account]));
        if (key !== this._accountKey) {
            this._accountKey = key;
            menu.removeAll();
            this._accountItems.clear();
            if (rows.message) {
                const item = new PopupMenu.PopupMenuItem(rows.message);
                item.setSensitive(false);
                menu.addMenuItem(item);
            } else {
                rows.profiles.forEach((row, index) => {
                    const item = this._profileItem(row);
                    this._accountItems.set(index, item);
                    menu.addMenuItem(item);
                });
            }
        }
        (rows.profiles ?? []).forEach((row, index) => {
            const item = this._accountItems.get(index);
            item.profileSelected = row.selected;
            item.setOrnament(row.selected ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.setSensitive(row.sensitive);
            item.progressLabel.text = row.progress;
            item.progressLabel.visible = row.progress !== '';
        });
    }

    /** A profile row: the tailnet, the account under it, and the progress on its right. */
    _profileItem(row) {
        const item = new KeepOpenMenuItem();
        const text = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(new St.Label({text: row.title}));
        if (row.account !== '')
            text.add_child(dimLabel(row.account, {style: 'font-size: 0.9em;'}));
        item.add_child(text);
        item.progressLabel = dimLabel('', {visible: false});
        item.add_child(item.progressLabel);
        item.profileSelected = row.selected;
        // Activating the profile in use does nothing.
        item.onActivate(() => {
            if (!item.profileSelected)
                this._engine.runAction('switch', ['switch', row.id], {id: row.id});
        });
        return item;
    }

    _renderExitNode(model, shown) {
        const menu = this._exitMenu.menu;
        this._exitMenu.visible = shown;
        if (!shown)
            menu.close(false);
        const rows = exitNodeRows(model.status, model.pending);
        this._exitSummary.text = rows.summary;
        this._exitMenu.setSensitive(rows.available);
        if (!rows.available)
            menu.close(false);
        this._updateExitItem(this._exitNone, null, rows.none);

        // Rows are kept by peer ID: a refresh updates them in place, so an open submenu, and the
        // scroll position, stay as they are.
        const wanted = new Set(rows.nodes.map(row => row.id));
        for (const [id, item] of this._exitItems) {
            if (!wanted.has(id)) {
                item.destroy();
                this._exitItems.delete(id);
            }
        }
        rows.nodes.forEach((row, index) => {
            let item = this._exitItems.get(row.id);
            if (!item) {
                item = this._exitNodeItem(row.name, true);
                item.exitId = row.id;
                item.onActivate(() => {
                    if (!item.exitChecked)
                        this._engine.runAction('exit', exitNodeArguments(item.exitAddress), {target: item.exitId});
                });
                this._exitItems.set(row.id, item);
                menu.addMenuItem(item, index + 1);
            }
            this._updateExitItem(item, JSON.stringify([row.name, row.online, this._dark]), row);
        });
        // Only a change of order moves rows.
        const current = menu._getMenuItems();
        const order = [this._exitNone, ...rows.nodes.map(row => this._exitItems.get(row.id)), this._lanItem];
        if (current.some((item, index) => item !== order[index]))
            order.forEach((item, index) => menu.moveMenuItem(item, index));

        this._rendering = true;
        const lan = switchRow(model.prefs, model.pending, LAN_ACCESS);
        this._lanItem.setToggleState(lan.value);
        this._lanItem.setSensitive(lan.sensitive);
        this._rendering = false;
    }

    // Brings a row up to date with its model. `look` keys the name, dot, and badge of a node row,
    // which are redrawn only when it changes; None has none of them.
    _updateExitItem(item, look, row) {
        item.exitChecked = row.checked;
        item.exitAddress = row.address;
        item.setOrnament(row.checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        item.setSensitive(row.sensitive);
        item.progressLabel.text = row.progress;
        item.progressLabel.visible = row.progress !== '';
        if (!item.dot || look === item.exitLook)
            return;
        item.exitLook = look;
        item.nameLabel.text = row.name;
        item.badge.visible = !row.online;
        item.dot.style = 'width: 8px; height: 8px; border-radius: 4px; margin-right: 8px; ' +
            `background-color: ${this._palette[row.online ? 'online' : 'offline']};`;
    }

    _renderSettings(model, shown) {
        this._settingsMenu.visible = shown;
        if (!shown)
            this._settingsMenu.menu.close(false);
        // Updating a switch from a refresh must not look like the user's toggle.
        this._rendering = true;
        for (const row of settingRows(model.prefs, model.pending)) {
            const item = this._settingItems[row.id];
            item.setToggleState(row.value);
            item.setSensitive(row.sensitive);
        }
        this._rendering = false;
    }

    _renderPanel(model, headerLabel) {
        const icon = panelIconModel(model.state, headerLabel, exitNodeInUse(model.status) !== null);
        const file = GLYPH_FILES[icon.glyph];
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
