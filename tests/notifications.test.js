import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {ACTION_WINDOW_MS, evaluateRefresh, MAX_NOTIFIED_EXPIRIES} from '../src/notifications.js';
import {readStatus, STATES} from '../src/status.js';

const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const BACKEND = {
    connected: 'Running',
    connecting: 'Starting',
    disconnected: 'Stopped',
    login: 'NeedsLogin',
    approval: 'NeedsMachineAuth',
};

/** A good refresh in a state, built from a fixture with `change` applied to its status. */
function refresh(stateId, change = () => {}, base = 'status-running.json') {
    const status = fixture(base);
    status.BackendState = BACKEND[stateId];
    change(status);
    return {state: readStatus({exitCode: 0, stdout: JSON.stringify(status)}).state, status};
}

const run = (previous, current, extra = {}) =>
    evaluateRefresh({previous, current, lastActionMs: null, nowMs: NOW, notified: [], ...extra});
const kinds = result => result.notifications.map(notification => notification.kind);

const withExit = (id, online) => status => {
    for (const peer of Object.values(status.Peer))
        peer.ExitNode = peer.ID === id;
    for (const peer of Object.values(status.Peer)) {
        if (peer.ID === id)
            peer.Online = online;
    }
};

test('the baseline sends no transition notification', () => {
    for (const stateId of ['connected', 'disconnected', 'login', 'approval'])
        assert.deepEqual(kinds(run(null, refresh(stateId))), []);
});

test('Connection lost: Connected to anything else, with the new header label as body', () => {
    const connected = refresh('connected');
    for (const [stateId, label] of [['disconnected', 'Disconnected'], ['connecting', 'Connecting…']]) {
        const result = run(connected, refresh(stateId));
        assert.deepEqual(result.notifications, [{kind: 'connection-lost', title: 'Connection lost', body: label}]);
    }
    assert.deepEqual(kinds(run(connected, refresh('connected'))), []);
    assert.deepEqual(kinds(run(refresh('disconnected'), refresh('connecting'))), []);
});

test('Connection lost is not sent within 30 seconds of an action, and is after', () => {
    const connected = refresh('connected');
    const stopped = refresh('disconnected');
    const at = ago => run(connected, stopped, {lastActionMs: NOW - ago});
    assert.deepEqual(kinds(at(0)), []);
    assert.deepEqual(kinds(at(ACTION_WINDOW_MS - 1)), []);
    assert.deepEqual(kinds(at(ACTION_WINDOW_MS)), ['connection-lost']);
    assert.deepEqual(kinds(at(10 * DAY)), ['connection-lost']);
});

test('the action window does not hold back the other notifications', () => {
    const connected = refresh('connected');
    const result = run(connected, refresh('login'), {lastActionMs: NOW});
    assert.deepEqual(kinds(result), ['login']);
});

test('Login required and Approval required: from any other state, with the header label', () => {
    const login = run(refresh('connected'), refresh('login'));
    assert.deepEqual(login.notifications.find(n => n.kind === 'login'),
        {kind: 'login', title: 'Login required', body: 'Login required'});
    assert.equal(login.loginActive, true);
    const approval = run(refresh('disconnected'), refresh('approval'));
    assert.deepEqual(kinds(approval), ['login']);
    assert.equal(approval.notifications[0].body, 'Waiting for approval');
});

test('Login required is not sent again while the state stays in Login or Approval required', () => {
    assert.deepEqual(kinds(run(refresh('login'), refresh('login'))), []);
    assert.deepEqual(kinds(run(refresh('login'), refresh('approval'))), []);
    assert.equal(run(refresh('login'), refresh('approval')).loginActive, true);
});

test('Connected to Login required sends both Connection lost and Login required', () => {
    assert.deepEqual(kinds(run(refresh('connected'), refresh('login'))), ['connection-lost', 'login']);
});

test('loginActive is false once the state leaves Login and Approval required', () => {
    assert.equal(run(refresh('login'), refresh('connected')).loginActive, false);
    assert.equal(run(refresh('approval'), refresh('disconnected')).loginActive, false);
    assert.equal(run(null, refresh('connected')).loginActive, false);
});

test('Exit node offline: the same peer, online before and offline now', () => {
    const before = refresh('connected', withExit('nPEER000000002', true));
    const after = refresh('connected', withExit('nPEER000000002', false));
    const result = run(before, after);
    assert.deepEqual(result.notifications, [
        {kind: 'exit-node-offline', title: 'Exit node offline', body: 'phone is offline.'},
    ]);
    // Offline before: nothing new. Online again: nothing.
    assert.deepEqual(kinds(run(after, after)), []);
    assert.deepEqual(kinds(run(after, before)), []);
});

test('exit node A online to exit node B offline sends nothing', () => {
    const a = refresh('connected', withExit('nPEER000000001', true));
    const b = refresh('connected', status => {
        withExit('nPEER000000002', false)(status);
    });
    assert.deepEqual(kinds(run(a, b)), []);
});

test('no exit node in use before or now sends nothing', () => {
    const none = refresh('connected');
    const used = refresh('connected', withExit('nPEER000000002', false));
    assert.deepEqual(kinds(run(none, used)), []);
    assert.deepEqual(kinds(run(used, none)), []);
});

test('an exit node that is offline while Tailtray starts is not a transition', () => {
    assert.deepEqual(kinds(run(null, refresh('connected', withExit('nPEER000000002', false)))), []);
});

const expiring = (days, id = 'nSELF000000000') => status => {
    status.Self.ID = id;
    status.Self.KeyExpiry = new Date(NOW + days * DAY).toISOString();
};

test('Key expiring: within 7 days, with the warning text as body, and it can be sent at the baseline', () => {
    const current = refresh('connected', expiring(3));
    const result = run(null, current);
    assert.deepEqual(result.notifications, [
        {kind: 'key-expiring', title: 'Key expiring', body: 'This device\'s key expires in 3 days.'},
    ]);
    assert.deepEqual(result.notified, [`nSELF000000000 ${current.status.Self.KeyExpiry}`]);
});

test('Key expiring: an expired key is notified, a key beyond 7 days or without expiry is not', () => {
    assert.equal(run(null, refresh('connected', expiring(-1))).notifications[0].body,
        'This device\'s key has expired.');
    assert.deepEqual(kinds(run(null, refresh('connected', expiring(8)))), []);
    assert.deepEqual(kinds(run(null, refresh('connected', status => {
        delete status.Self.KeyExpiry;
    }))), []);
    assert.deepEqual(kinds(run(null, refresh('connected', status => {
        status.Self.KeyExpiry = '0001-01-01T00:00:00Z';
    }))), []);
});

test('Key expiring is not sent again for a pair already notified, and the list is unchanged', () => {
    const current = refresh('connected', expiring(3));
    const notified = [`nSELF000000000 ${current.status.Self.KeyExpiry}`];
    const result = run(current, current, {notified});
    assert.deepEqual(kinds(result), []);
    assert.equal(result.notified, notified);
});

test('Key expiring: a new expiry, or another device, can be notified again', () => {
    const first = refresh('connected', expiring(3));
    const notified = [`nSELF000000000 ${first.status.Self.KeyExpiry}`];
    assert.deepEqual(kinds(run(first, refresh('connected', expiring(2)), {notified})), ['key-expiring']);
    assert.deepEqual(kinds(run(first, refresh('connected', expiring(3, 'nOTHER00000000')), {notified})),
        ['key-expiring']);
});

test('Key expiring without a device ID sends nothing', () => {
    assert.deepEqual(kinds(run(null, refresh('connected', status => {
        expiring(3)(status);
        delete status.Self.ID;
    }))), []);
});

test('the notified pairs keep the last 10', () => {
    const old = Array.from({length: MAX_NOTIFIED_EXPIRIES}, (_, i) => `nOLD${i} 2026-11-0${i % 9 + 1}T00:00:00Z`);
    const current = refresh('connected', expiring(3));
    const pair = `nSELF000000000 ${current.status.Self.KeyExpiry}`;
    const result = run(null, current, {notified: old});
    assert.equal(result.notified.length, MAX_NOTIFIED_EXPIRIES);
    assert.deepEqual(result.notified, [...old.slice(1), pair]);
    // Ten later pairs push it out, and it can be notified again.
    let notified = result.notified;
    for (let i = 0; i < MAX_NOTIFIED_EXPIRIES; i++)
        notified = run(null, refresh('connected', expiring(3, `nLATER${i}`)), {notified}).notified;
    assert.equal(notified.length, MAX_NOTIFIED_EXPIRIES);
    assert.equal(notified.includes(pair), false);
    assert.deepEqual(kinds(run(null, current, {notified})), ['key-expiring']);
});

test('a failed refresh between two good ones is not a transition', () => {
    // The caller passes only good refreshes, so the next good one is compared with the last good.
    const connected = refresh('connected');
    assert.deepEqual(kinds(run(connected, connected)), []);
    assert.deepEqual(kinds(run(connected, refresh('disconnected'))), ['connection-lost']);
});

test('Unavailable is not a Tailtray state to compare', () => {
    assert.equal(STATES.unavailable.id, 'unavailable');
    assert.deepEqual(kinds(run(refresh('connected'), refresh('connected'))), []);
});
