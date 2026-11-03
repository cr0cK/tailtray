import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const INTERVALS = [5, 10, 30, 60];
const INTERVAL_LABELS = ['5 seconds', '10 seconds', '30 seconds', '1 minute'];

export default class TailtrayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const interval = new Adw.ComboRow({
            title: 'Refresh interval',
            subtitle: 'Time between two reads of the Tailscale state.',
            model: Gtk.StringList.new(INTERVAL_LABELS),
        });
        const current = INTERVALS.indexOf(settings.get_uint('refresh-interval'));
        interval.selected = current >= 0 ? current : Gtk.INVALID_LIST_POSITION;
        // Changes apply at once, without a save button.
        interval.connect('notify::selected', () => {
            if (interval.selected !== Gtk.INVALID_LIST_POSITION)
                settings.set_uint('refresh-interval', INTERVALS[interval.selected]);
        });

        const notifications = new Adw.SwitchRow({
            title: 'Notifications',
            subtitle: 'Tell me when the connection is lost, a login is needed, an exit node goes offline, or the key is about to expire.',
        });
        settings.bind('notifications', notifications, 'active', Gio.SettingsBindFlags.DEFAULT);

        const general = new Adw.PreferencesGroup({title: 'General'});
        general.add(interval);
        general.add(notifications);

        const version = new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? 'unknown',
            subtitle_selectable: true,
        });
        const about = new Adw.PreferencesGroup({title: 'About'});
        about.add(version);

        const page = new Adw.PreferencesPage();
        page.add(general);
        page.add(about);
        window.add(page);
    }
}
