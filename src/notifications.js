import {peerId, peersOf} from './devices.js';
import {exitNodeInUse} from './exitnodes.js';
import {keyExpiryWarning} from './warnings.js';

/** An action of Tailtray that started within this long explains a lost connection. */
export const ACTION_WINDOW_MS = 30 * 1000;
/** How many notified key expiries are remembered. */
export const MAX_NOTIFIED_EXPIRIES = 10;

const LOGIN_STATES = new Set(['login', 'approval']);

/** The peer in use as exit node with its `Online` flag, `{id, name, online}`, or null. */
function exitNodeOf(status) {
    const inUse = exitNodeInUse(status);
    if (!inUse)
        return null;
    const found = peersOf(status).find(([key, peer]) => peerId(key, peer) === inUse.id);
    return {...inUse, online: found?.[1].Online === true};
}

/**
 * The notifications a good refresh calls for, and the key expiries notified afterwards.
 *
 * `previous` is the last good refresh, or null for the first one after the extension was enabled
 * (the baseline: it sends no transition notification). `current` is this good refresh. Both are
 * `{state, status}`; failed and discarded refreshes are never passed, so they are never compared.
 * `lastActionMs` is when the last action of Tailtray started, or null, and `nowMs` the time of
 * `current`. `notified` holds the `<Self.ID> <KeyExpiry>` pairs already notified.
 *
 * Returns `{notifications, notified, loginActive}`: `notifications` is a list of
 * `{kind, title, body}`, `notified` the pairs to store (the last 10), and `loginActive` whether
 * the state is Login required or Approval required, which a Login required notification
 * outlives.
 */
export function evaluateRefresh({previous, current, lastActionMs, nowMs, notified}) {
    const notifications = [];
    const state = current.state;
    const loginActive = LOGIN_STATES.has(state.id);

    if (previous) {
        const acted = lastActionMs !== null && nowMs - lastActionMs < ACTION_WINDOW_MS;
        if (previous.state.id === 'connected' && state.id !== 'connected' && !acted)
            notifications.push({kind: 'connection-lost', title: 'Connection lost', body: state.label});
        if (loginActive && !LOGIN_STATES.has(previous.state.id))
            notifications.push({kind: 'login', title: 'Login required', body: state.label});
        const before = exitNodeOf(previous.status);
        const now = exitNodeOf(current.status);
        if (before && now && before.id === now.id && before.online && !now.online)
            notifications.push({kind: 'exit-node-offline', title: 'Exit node offline', body: `${now.name} is offline.`});
    }

    const self = current.status?.Self;
    const warning = keyExpiryWarning(self?.KeyExpiry, nowMs);
    const pair = typeof self?.ID === 'string' && self.ID !== '' ? `${self.ID} ${self.KeyExpiry}` : null;
    let stored = notified;
    if (warning && pair && !notified.includes(pair)) {
        notifications.push({kind: 'key-expiring', title: 'Key expiring', body: warning});
        stored = [...notified, pair].slice(-MAX_NOTIFIED_EXPIRIES);
    }
    return {notifications, notified: stored, loginActive};
}
