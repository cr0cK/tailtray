import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {
    headerModel,
    identityLine,
    panelIconModel,
    readStatus,
    sectionsOf,
    separatorsOf,
    STATES,
    stateOfBackend,
} from '../src/status.js';

const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const ok = stdout => ({exitCode: 0, stdout, stderr: ''});
const withBackend = backend => ok(JSON.stringify({BackendState: backend}));

test('every BackendState maps to its state and label', () => {
    const expected = {
        Running: ['connected', 'Connected'],
        Starting: ['connecting', 'Connecting…'],
        NoState: ['connecting', 'Connecting…'],
        Stopped: ['disconnected', 'Disconnected'],
        NeedsLogin: ['login', 'Login required'],
        NeedsMachineAuth: ['approval', 'Waiting for approval'],
    };
    for (const [backend, [id, label]] of Object.entries(expected)) {
        const read = readStatus(withBackend(backend));
        assert.equal(read.ok, true, backend);
        assert.equal(read.state.id, id);
        assert.equal(read.state.label, label);
    }
});

test('a BackendState Tailtray does not know is unreadable', () => {
    for (const backend of ['Weird', '', 'running', 'toString', 'constructor', 7, null]) {
        const read = readStatus(withBackend(backend));
        assert.equal(read.ok, false, String(backend));
        assert.equal(read.failure.unreadable, true);
    }
    assert.equal(stateOfBackend('hasOwnProperty'), null);
});

test('a status is read from stdout before the exit code is looked at', () => {
    const read = readStatus({exitCode: 1, stdout: fixture('status-stopped.json'), stderr: ''});
    assert.equal(read.ok, true);
    assert.equal(read.state.id, 'disconnected');
});

test('a missing CLI and a timeout fail without reading the output', () => {
    const missing = readStatus({missing: true, exitCode: -1, stdout: '', stderr: ''});
    assert.equal(missing.ok, false);
    assert.equal(missing.failure.missing, true);
    const timedOut = readStatus({timedOut: true, exitCode: -1, stdout: fixture('status-running.json'), stderr: ''});
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.failure.timedOut, true);
});

test('a command that fails with nothing to read keeps its own failure', () => {
    const read = readStatus({
        exitCode: 1,
        stdout: '',
        stderr: 'failed to connect to local tailscaled',
    });
    assert.equal(read.ok, false);
    assert.equal(read.failure.unreadable, undefined);
    assert.equal(read.failure.exitCode, 1);
});

test('output that is not a status object is unreadable when the command succeeded', () => {
    for (const stdout of ['', 'not json', '[]', 'null', '"text"', '3']) {
        const read = readStatus(ok(stdout));
        assert.equal(read.ok, false, stdout);
        assert.equal(read.failure.unreadable, true, stdout);
    }
});

test('the fixtures of every state read back to their state', () => {
    const expected = {
        'status-running.json': 'connected',
        'status-connecting.json': 'connecting',
        'status-stopped.json': 'disconnected',
        'status-needs-login.json': 'login',
        'status-needs-approval.json': 'approval',
    };
    for (const [name, id] of Object.entries(expected))
        assert.equal(readStatus(ok(fixture(name))).state.id, id, name);
});

test('identityLine joins the tailnet and the login name', () => {
    const status = JSON.parse(fixture('status-running.json'));
    assert.equal(identityLine(status), 'example.org · alex@example.org');
});

test('identityLine leaves out a missing part with its separator', () => {
    const status = JSON.parse(fixture('status-running.json'));
    delete status.CurrentTailnet;
    assert.equal(identityLine(status), 'alex@example.org');
    const noUser = JSON.parse(fixture('status-running.json'));
    noUser.User = {};
    assert.equal(identityLine(noUser), 'example.org');
    const noSelf = JSON.parse(fixture('status-running.json'));
    delete noSelf.Self;
    assert.equal(identityLine(noSelf), 'example.org');
});

test('identityLine is empty with both parts missing', () => {
    assert.equal(identityLine({}), '');
    assert.equal(identityLine({CurrentTailnet: {Name: ''}, Self: {UserID: 5}, User: {5: {LoginName: ''}}}), '');
    assert.equal(identityLine(null), '');
});

test('the header has a switch only when connected, connecting, or disconnected', () => {
    const switches = {};
    for (const state of Object.values(STATES))
        switches[state.id] = headerModel(state, null, true).switchOn;
    assert.deepEqual(switches, {
        connected: true,
        connecting: true,
        disconnected: false,
        login: null,
        approval: null,
        unavailable: null,
    });
});

test('the header colours the label in the blocked states only', () => {
    const colors = Object.values(STATES).map(state => headerModel(state, null, true).labelColor);
    assert.deepEqual(colors, [null, null, null, 'warning', 'warning', 'error']);
});

test('a pending up or down changes the label and locks the switch', () => {
    const up = headerModel(STATES.disconnected, {kind: 'up'}, true);
    assert.equal(up.label, 'Connecting…');
    assert.equal(up.switchOn, true);
    assert.equal(up.switchSensitive, false);
    const down = headerModel(STATES.connected, {kind: 'down'}, true);
    assert.equal(down.label, 'Disconnecting…');
    assert.equal(down.switchOn, false);
    assert.equal(down.switchSensitive, false);
});

test('the switch is usable once the first answer arrived and nothing is pending', () => {
    assert.equal(headerModel(STATES.connected, null, true).switchSensitive, true);
    assert.equal(headerModel(STATES.connecting, null, false).switchSensitive, false);
    assert.equal(headerModel(STATES.login, null, true).switchSensitive, false);
});

test('the panel icon follows the state', () => {
    const icon = id => panelIconModel(STATES[id]);
    assert.deepEqual(icon('connected'), {
        glyph: 'filled', dimmed: false, badge: null, name: 'Tailscale: Connected',
    });
    for (const id of ['connecting', 'disconnected'])
        assert.deepEqual([icon(id).glyph, icon(id).dimmed, icon(id).badge], ['outline', true, null]);
    for (const id of ['login', 'approval'])
        assert.deepEqual([icon(id).glyph, icon(id).dimmed, icon(id).badge], ['outline', false, 'warning']);
    assert.deepEqual([icon('unavailable').glyph, icon('unavailable').dimmed, icon('unavailable').badge],
        ['outline', true, 'error']);
});

test('the accessible name of the icon carries the header label', () => {
    assert.equal(panelIconModel(STATES.approval).name, 'Tailscale: Waiting for approval');
    assert.equal(panelIconModel(STATES.connecting).name, 'Tailscale: Connecting…');
});

test('the accessible name of the icon follows the label of a pending action', () => {
    assert.equal(panelIconModel(STATES.connected, 'Disconnecting…').name, 'Tailscale: Disconnecting…');
    assert.equal(panelIconModel(STATES.disconnected, 'Connecting…').name, 'Tailscale: Connecting…');
});

test('the menu layout matches the spec table through P3', () => {
    const shown = id => Object.entries(sectionsOf(STATES[id])).filter(([, on]) => on).map(([name]) => name);
    assert.deepEqual(shown('connected'), ['identity', 'errorBlock', 'warnings', 'thisDevice', 'account', 'exitNode', 'settings']);
    assert.deepEqual(shown('connecting'), ['identity', 'errorBlock', 'warnings', 'account']);
    assert.deepEqual(shown('disconnected'), ['identity', 'errorBlock', 'warnings', 'account', 'settings']);
    assert.deepEqual(shown('login'), ['warnings', 'loginHelp']);
    assert.deepEqual(shown('approval'), ['warnings', 'approvalHelp']);
    assert.deepEqual(shown('unavailable'), ['errorBlock']);
});

test('separators sit between groups and never touch', () => {
    const seps = (device, controls) => separatorsOf({device, controls});
    assert.deepEqual(seps(true, true), {top: true, device: true, footer: true});
    assert.deepEqual(seps(false, true), {top: true, device: false, footer: true});
    assert.deepEqual(seps(true, false), {top: true, device: false, footer: true});
    assert.deepEqual(seps(false, false), {top: false, device: false, footer: true});
});

test('connected through an exit node has the arrow glyph, whatever the exit node does', () => {
    assert.deepEqual(panelIconModel(STATES.connected, 'Connected', true), {
        glyph: 'exit', dimmed: false, badge: null, name: 'Tailscale: Connected',
    });
    // The other states keep their own look, even with an exit node in use: the arrow is for
    // Connected only.
    for (const id of ['connecting', 'disconnected', 'login', 'approval', 'unavailable'])
        assert.notEqual(panelIconModel(STATES[id], undefined, true).glyph, 'exit');
});
