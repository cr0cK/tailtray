import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {evaluateRefresh} from './notifications.js';

const NOTIFICATIONS_KEY = 'notifications';
const NOTIFIED_KEY = 'notified-key-expiries';

/**
 * Sends the notifications of good refreshes through one Tailtray message source. The rules are
 * in notifications.js; this class keeps the last good refresh, owns the source, and withdraws
 * the Login required notification.
 *
 * A message source destroys itself when its last notification goes, so it is created when a
 * notification needs it and dropped on its `destroy` signal, never kept once destroyed.
 * `deps`: settings (Gio.Settings), icon (Gio.Icon), openMenu().
 */
export class Notifier {
    constructor(deps) {
        this._deps = deps;
        this._destroyed = false;
        // The last good refresh, `{state, status}`; null until the baseline is set.
        this._previous = null;
        this._source = null;
        this._sourceDestroyId = 0;
        this._login = null;
    }

    /** A good refresh that counts: `{state, status, nowMs, lastActionMs}`. */
    refreshed({state, status, nowMs, lastActionMs}) {
        if (this._destroyed)
            return;
        const settings = this._deps.settings;
        const previous = this._previous;
        const current = {state, status};
        this._previous = current;
        const notified = settings.get_strv(NOTIFIED_KEY);
        const result = evaluateRefresh({previous, current, lastActionMs, nowMs, notified});
        if (!result.loginActive)
            this._withdrawLogin();
        // The preference only gates sending: the baseline moves on, and a key expiry not sent is
        // not remembered as notified.
        if (!settings.get_boolean(NOTIFICATIONS_KEY))
            return;
        for (const notification of result.notifications)
            this._send(notification);
        if (result.notified !== notified)
            settings.set_strv(NOTIFIED_KEY, result.notified);
    }

    /** Removes every notification Tailtray owns, and the source. */
    destroy() {
        this._destroyed = true;
        const source = this._source;
        this._source = null;
        this._login = null;
        if (source) {
            source.disconnect(this._sourceDestroyId);
            source.destroy();
        }
        this._sourceDestroyId = 0;
        this._previous = null;
    }

    _ensureSource() {
        if (this._source)
            return this._source;
        const source = new MessageTray.Source({title: 'Tailtray', icon: this._deps.icon});
        this._sourceDestroyId = source.connect('destroy', () => {
            if (this._source === source) {
                this._source = null;
                this._sourceDestroyId = 0;
            }
        });
        this._source = source;
        Main.messageTray.add(source);
        return source;
    }

    _send({kind, title, body}) {
        const source = this._ensureSource();
        const notification = new MessageTray.Notification({source, title, body, gicon: this._deps.icon});
        notification.connect('activated', () => this._deps.openMenu());
        if (kind === 'login') {
            this._withdrawLogin();
            this._login = notification;
            // The reference goes with the notification, whoever destroys it: the user, the
            // source's limit, or a withdrawal.
            notification.connect('destroy', () => {
                if (this._login === notification)
                    this._login = null;
            });
        }
        source.addNotification(notification);
    }

    _withdrawLogin() {
        this._login?.destroy();
    }
}
