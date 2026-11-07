import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {Engine} from '../src/engine.js';

const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const STATUS = {
    running: fixture('status-running.json'),
    stopped: fixture('status-stopped.json'),
    login: fixture('status-needs-login.json'),
    approval: fixture('status-needs-approval.json'),
};
const GET = fixture('get.json');
const PROFILES = fixture('switch-list.json');
const ok = (stdout = '') => ({exitCode: 0, stdout, stderr: ''});
const fail = (stderr, fields = {}) => ({exitCode: 1, stdout: '', stderr, ...fields});

/**
 * An engine whose commands and timers the test resolves by hand. `get --json` answers by itself
 * with `env.get`, unless `manualGet` is set; those reads land in `gets`, not in `calls`. So does
 * `serve status --json` with `env.serve`, unless `manualServe` is set; its reads land in
 * `serves`.
 */
function setup({interval = 10, manualGet = false, manualServe = false} = {}) {
    const calls = [];
    const gets = [];
    const serves = [];
    const timers = [];
    const changes = [];
    const good = [];
    let nextId = 1;
    const env = {interval, now: 1_000_000, get: ok(GET), serve: ok('null')};
    const engine = new Engine({
        run: (args, timeout) => new Promise(resolve => {
            const name = args.join(' ');
            if (name === 'get --json' && !manualGet) {
                gets.push({args, timeout});
                resolve(env.get);
                return;
            }
            if (name === 'serve status --json' && !manualServe) {
                serves.push({args, timeout});
                resolve(env.serve);
                return;
            }
            calls.push({args, timeout, resolve, name});
        }),
        setTimer: (ms, callback) => {
            const timer = {id: nextId++, ms};
            // A timer that fired is gone, as a GLib source is.
            timer.callback = () => {
                timers.splice(timers.indexOf(timer), 1);
                callback();
            };
            timers.push(timer);
            return timer.id;
        },
        clearTimer: id => {
            const index = timers.findIndex(timer => timer.id === id);
            if (index >= 0)
                timers.splice(index, 1);
        },
        now: () => env.now,
        intervalSeconds: () => env.interval,
        userName: 'alex',
        onChange: model => changes.push(model.state.id),
        onGoodRefresh: refresh => good.push(refresh),
    });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    /** Answers the oldest unanswered call whose name matches, then lets the engine react. */
    const answer = async (name, result) => {
        const call = calls.find(entry => entry.name === name && !entry.done);
        assert.ok(call, `no pending ${name} call`);
        call.done = true;
        call.resolve(result);
        await tick();
    };
    const pending = name => calls.filter(entry => entry.name === name && !entry.done).length;
    return {
        engine, calls, gets, serves, timers, changes, good, env, answer, pending, tick,
        model: () => engine.model,
    };
}

test('the first refresh runs status --json when the engine starts', async () => {
    const t = setup();
    t.engine.start();
    assert.deepEqual(t.calls.map(call => call.name), ['status --json']);
    assert.equal(t.calls[0].timeout, 30);
    assert.equal(t.model().loaded, false);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().loaded, true);
    assert.equal(t.model().state.id, 'connected');
    assert.equal(t.model().updatedAt, 1_000_000);
});

test('three requests during a slow refresh run exactly one more refresh', async () => {
    const t = setup();
    t.engine.start();
    t.engine.requestRefresh();
    t.engine.requestRefresh();
    t.engine.requestRefresh();
    assert.equal(t.calls.length, 1);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.calls.length, 2);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.calls.length, 2);
});

test('the next refresh is counted from the end of the previous one', async () => {
    const t = setup({interval: 10});
    t.engine.start();
    assert.equal(t.timers.length, 0);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.timers.length, 1);
    assert.equal(t.timers[0].ms, 10_000);
    t.timers[0].callback();
    assert.equal(t.calls.length, 2);
    assert.equal(t.timers.length, 0);
});

test('a new interval applies from the next scheduled refresh', async () => {
    const t = setup({interval: 10});
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.env.interval = 60;
    assert.equal(t.timers[0].ms, 10_000);
    t.timers[0].callback();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.timers.length, 1);
    assert.equal(t.timers[0].ms, 60_000);
});

test('a failing status shows Unavailable with its error, and a good one clears it', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', fail('failed to connect to local tailscaled'));
    assert.equal(t.model().state.id, 'unavailable');
    assert.equal(t.model().refreshError.text, 'The Tailscale service is not running.');
    assert.equal(t.model().status, null);
    t.timers[0].callback();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().state.id, 'connected');
    assert.equal(t.model().refreshError, null);
});

test('a missing CLI and a timed out read both show Unavailable', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', {missing: true, exitCode: -1, stdout: '', stderr: ''});
    assert.equal(t.model().refreshError.text, 'The Tailscale CLI is not installed.');
    t.timers[0].callback();
    await t.answer('status --json', {timedOut: true, exitCode: -1, stdout: '', stderr: ''});
    assert.equal(t.model().refreshError.text, 'The command timed out.');
});

test('an action runs one command, then a follow-up refresh, and keeps the state it reads', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.stopped));
    assert.equal(t.model().state.id, 'disconnected');

    assert.equal(t.engine.runAction('up', ['up']), true);
    assert.deepEqual(t.model().pending, {kind: 'up'});
    assert.equal(t.pending('up'), 1);
    await t.answer('up', ok());
    assert.equal(t.pending('status --json'), 1);
    assert.deepEqual(t.model().pending, {kind: 'up'});
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().pending, null);
    assert.equal(t.model().state.id, 'connected');
    assert.equal(t.model().actionError, null);
});

test('only one action runs at a time', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.engine.runAction('down', ['down']), true);
    assert.equal(t.engine.runAction('up', ['up']), false);
    assert.equal(t.calls.filter(call => call.name === 'up').length, 0);
});

test('a refresh that completes while an action is pending is discarded', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    t.engine.requestRefresh();
    assert.equal(t.pending('status --json'), 1);
    // The periodic read sees the state from before the action; it must not show.
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().state.id, 'connected');
    assert.deepEqual(t.model().pending, {kind: 'down'});

    // One that ends after the command did, before the follow-up answered, is discarded too.
    t.engine.requestRefresh();
    await t.answer('down', ok());
    await t.answer('status --json', ok(STATUS.running));
    assert.deepEqual(t.model().pending, {kind: 'down'});
    assert.equal(t.model().state.id, 'connected');
    await t.answer('status --json', ok(STATUS.stopped));
    assert.equal(t.model().pending, null);
    assert.equal(t.model().state.id, 'disconnected');
});

test('a refresh that started before the action ended is discarded', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.requestRefresh();
    assert.equal(t.pending('status --json'), 1);
    t.engine.runAction('down', ['down']);
    await t.answer('down', ok());
    // The slow read, started before `down` ended, answers with the old state.
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().state.id, 'connected');
    assert.deepEqual(t.model().pending, {kind: 'down'});
    // The follow-up waited for it and now shows the new state.
    assert.equal(t.pending('status --json'), 1);
    await t.answer('status --json', ok(STATUS.stopped));
    assert.equal(t.model().state.id, 'disconnected');
    assert.equal(t.model().pending, null);
});

test('a refresh that started during an action and ends after it is discarded', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    t.engine.requestRefresh();
    await t.answer('down', ok());
    // The follow-up is queued behind the periodic read; it takes the queued refresh's place.
    t.engine.requestRefresh();
    await t.answer('status --json', ok(STATUS.running));
    await t.answer('status --json', ok(STATUS.stopped));
    assert.equal(t.model().state.id, 'disconnected');
    // The next periodic read counts again.
    t.timers[0].callback();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().state.id, 'connected');
});

test('a failed action shows its error only once its follow-up answered', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    await t.answer('down', fail('Access denied: prefs write access denied'));
    assert.equal(t.model().actionError, null);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError.text, 'Tailtray needs you to be the Tailscale operator.');
    assert.equal(t.model().actionError.command, 'sudo tailscale set --operator=alex');
    assert.equal(t.model().pending, null);
});

test('the error of a failed action stays until the next action starts', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    await t.answer('down', fail('boom'));
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError.text, 'boom');
    t.timers[0].callback();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError.text, 'boom');
    t.engine.runAction('down', ['down']);
    assert.equal(t.model().actionError, null);
});

test('closing the menu drops the error shown and the error of a pending action', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    await t.answer('down', fail('boom'));
    t.engine.menuClosed();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError, null);

    t.engine.runAction('down', ['down']);
    await t.answer('down', fail('again'));
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError.text, 'again');
    t.engine.menuClosed();
    assert.equal(t.model().actionError, null);
});

test('closing the menu while the command runs drops the error it fails with', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    t.engine.menuClosed();
    await t.answer('down', fail('Access denied: prefs write access denied'));
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError, null);
    assert.equal(t.model().pending, null);
    // The next action reports its own error again.
    t.engine.runAction('down', ['down']);
    await t.answer('down', fail('boom'));
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError.text, 'boom');
});

test('a failed action whose follow-up reads Login required or Approval required sets no error', async () => {
    for (const state of ['login', 'approval']) {
        const t = setup();
        t.engine.start();
        await t.answer('status --json', ok(STATUS.stopped));
        t.engine.runAction('up', ['up']);
        await t.answer('up', fail('needs login'));
        await t.answer('status --json', ok(STATUS[state]));
        assert.equal(t.model().state.id, state);
        assert.equal(t.model().actionError, null);
    }
});

test('an up that times out while status says Login required leaves no error', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.login));
    t.engine.runAction('up', ['up']);
    await t.answer('up', {timedOut: true, exitCode: -1, stdout: '', stderr: ''});
    await t.answer('status --json', ok(STATUS.login));
    assert.equal(t.model().state.id, 'login');
    assert.equal(t.model().actionError, null);
});

test('a timed out action fails with its own text when the state is fine', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    await t.answer('down', {timedOut: true, exitCode: -1, stdout: '', stderr: ''});
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError.text, 'The command timed out.');
});

test('a failed action whose follow-up fails shows the Unavailable error, not its own', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    await t.answer('down', fail('boom'));
    await t.answer('status --json', fail('failed to connect to local tailscaled'));
    assert.equal(t.model().state.id, 'unavailable');
    assert.equal(t.model().actionError, null);
    assert.equal(t.model().refreshError.text, 'The Tailscale service is not running.');
    assert.equal(t.model().pending, null);
});

test('a successful action leaves no error', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.stopped));
    t.engine.runAction('up', ['up']);
    await t.answer('up', ok());
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError, null);
});

test('destroy leaves no timer and ignores replies that arrive later', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.timers.length, 1);
    t.engine.destroy();
    assert.equal(t.timers.length, 0);

    const t2 = setup();
    t2.engine.start();
    const changesBefore = t2.changes.length;
    t2.engine.destroy();
    await t2.answer('status --json', ok(STATUS.running));
    assert.equal(t2.changes.length, changesBefore);
    assert.equal(t2.model().loaded, false);
    assert.equal(t2.timers.length, 0);
    assert.equal(t2.engine.runAction('up', ['up']), false);
    t2.engine.requestRefresh();
    assert.equal(t2.calls.length, 1);
});

test('a reply to an action that arrives after destroy starts no follow-up', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('down', ['down']);
    t.engine.destroy();
    await t.answer('down', ok());
    assert.equal(t.calls.filter(call => call.name === 'status --json').length, 1);
});

test('a refresh answered with the same state still notifies the view', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    const seen = t.changes.length;
    t.timers[0].callback();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.changes.length, seen + 1);
});

// --- Preferences: tailscale get --json -------------------------------------------------------

const STATUS_CONNECTING = fixture('status-connecting.json');
const names = t => t.calls.map(call => call.name);

test('get --json runs after status --json when the backend is Running or Stopped', async () => {
    for (const state of ['running', 'stopped']) {
        const t = setup({manualGet: true});
        t.engine.start();
        await t.answer('status --json', ok(STATUS[state]));
        assert.deepEqual(names(t), ['status --json', 'get --json']);
        assert.equal(t.calls[1].timeout, 30);
        assert.equal(t.model().loaded, false);
        await t.answer('get --json', ok(GET));
        assert.equal(t.model().loaded, true);
        assert.equal(t.model().prefs['accept-dns'], true);
    }
});

test('get --json is not called in the other states, nor when status failed', async () => {
    const answers = [
        ok(STATUS.login), ok(STATUS.approval), ok(STATUS_CONNECTING), fail('failed to connect to local tailscaled'),
        {missing: true, exitCode: -1, stdout: '', stderr: ''}, ok('not json'),
    ];
    for (const answer of answers) {
        const t = setup({manualGet: true});
        t.engine.start();
        await t.answer('status --json', answer);
        assert.deepEqual(names(t), ['status --json']);
        assert.equal(t.model().prefs, null);
    }
});

test('only one refresh runs at a time, get included', async () => {
    const t = setup({manualGet: true});
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.requestRefresh();
    t.engine.requestRefresh();
    assert.deepEqual(names(t), ['status --json', 'get --json']);
    await t.answer('get --json', ok(GET));
    assert.deepEqual(names(t), ['status --json', 'get --json', 'status --json']);
});

test('a failing get keeps the state, empties the preferences, and shows no error', async () => {
    const t = setup();
    t.env.get = fail('boom');
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().state.id, 'connected');
    assert.equal(t.model().prefs, null);
    assert.equal(t.model().refreshError, null);
    assert.equal(t.model().actionError, null);
    // A later good read brings the values back.
    t.env.get = ok(GET);
    t.timers[0].callback();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().prefs['shields-up'], false);
});

test('a get that prints garbage or times out empties the preferences', async () => {
    for (const reply of [ok('not json'), {timedOut: true, exitCode: -1, stdout: '', stderr: ''}]) {
        const t = setup();
        t.env.get = reply;
        t.engine.start();
        await t.answer('status --json', ok(STATUS.running));
        assert.equal(t.model().state.id, 'connected');
        assert.equal(t.model().prefs, null);
    }
});

test('a refresh known to be discarded does not read the preferences', async () => {
    const t = setup({manualGet: true});
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    await t.answer('get --json', ok(GET));
    t.engine.requestRefresh();
    t.engine.runAction('down', ['down']);
    await t.answer('down', ok());
    await t.answer('status --json', ok(STATUS.running));
    // The periodic read started before the command ended: no get for it, only for the follow-up.
    assert.deepEqual(names(t).filter(name => name === 'get --json'), ['get --json']);
    await t.answer('status --json', ok(STATUS.stopped));
    await t.answer('get --json', ok(GET));
    assert.equal(t.model().pending, null);
    assert.equal(t.model().state.id, 'disconnected');
});

test('an action started while get runs discards that refresh', async () => {
    const t = setup({manualGet: true});
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('set', ['set', '--shields-up=true'], {flag: 'shields-up', value: true});
    await t.answer('get --json', ok('{"shields-up": false}'));
    assert.equal(t.model().loaded, false);
    assert.deepEqual(t.model().pending, {kind: 'set', flag: 'shields-up', value: true});
});

test('the follow-up of a set shows the values get returns', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().prefs['shields-up'], false);
    assert.equal(t.engine.runAction('set', ['set', '--shields-up=true'], {flag: 'shields-up', value: true}), true);
    assert.deepEqual(t.model().pending, {kind: 'set', flag: 'shields-up', value: true});
    await t.answer('set --shields-up=true', fail('boom'));
    // A periodic refresh that completes now leaves the progress and the old values alone.
    t.engine.requestRefresh();
    assert.deepEqual(t.model().pending, {kind: 'set', flag: 'shields-up', value: true});
    // A killed set is not rolled back: the read may show the requested value.
    t.env.get = ok('{"shields-up": true}');
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().pending, null);
    assert.equal(t.model().prefs['shields-up'], true);
    assert.equal(t.model().actionError.text, 'boom');
});

test('a get that fails after a set leaves the switches without a value', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('set', ['set', '--accept-dns=false'], {flag: 'accept-dns', value: false});
    await t.answer('set --accept-dns=false', ok());
    t.env.get = fail('boom');
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().pending, null);
    assert.equal(t.model().prefs, null);
    assert.equal(t.model().state.id, 'connected');
    assert.equal(t.model().actionError, null);
});

// --- Account: tailscale switch --list --json -------------------------------------------------

const listCalls = t => t.calls.filter(call => call.name === 'switch --list --json');

async function openMenu(t, state = STATUS.running) {
    t.engine.start();
    await t.answer('status --json', ok(state));
    t.engine.menuOpened();
}

test('the profiles are listed once when the menu opens, and not by the refreshes', async () => {
    const t = setup();
    await openMenu(t);
    assert.equal(listCalls(t).length, 1);
    assert.equal(listCalls(t)[0].timeout, 30);
    assert.deepEqual(t.model().accounts, {profiles: null, loading: true, failed: false});
    await t.answer('switch --list --json', ok(PROFILES));
    assert.equal(t.model().accounts.loading, false);
    assert.equal(t.model().accounts.profiles.length, 2);
    for (let i = 0; i < 3; i++) {
        t.engine.requestRefresh();
        await t.answer('status --json', ok(STATUS.running));
    }
    assert.equal(listCalls(t).length, 1);
    // Closing and opening again lists once more.
    t.engine.menuClosed();
    t.engine.menuOpened();
    assert.equal(listCalls(t).length, 2);
});

test('opening the menu before the first answer lists the profiles once that answer shows them', async () => {
    const t = setup();
    t.engine.start();
    t.engine.menuOpened();
    assert.equal(listCalls(t).length, 0);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(listCalls(t).length, 1);
});

test('the profiles are listed in Disconnected and Connecting, not in the blocked states', async () => {
    const cases = [[STATUS.stopped, 1], [STATUS_CONNECTING, 1], [STATUS.login, 0], [STATUS.approval, 0]];
    for (const [state, listed] of cases) {
        const t = setup();
        await openMenu(t, state);
        assert.equal(listCalls(t).length, listed);
    }
    const t = setup();
    t.engine.start();
    await t.answer('status --json', fail('failed to connect to local tailscaled'));
    t.engine.menuOpened();
    assert.equal(listCalls(t).length, 0);
});

test('the previous profiles stay while a later list runs, and a failure leaves none', async () => {
    const t = setup();
    await openMenu(t);
    await t.answer('switch --list --json', ok(PROFILES));
    t.engine.menuClosed();
    t.engine.menuOpened();
    assert.deepEqual(t.model().accounts.loading, true);
    assert.equal(t.model().accounts.profiles.length, 2);
    await t.answer('switch --list --json', fail('boom'));
    assert.deepEqual(t.model().accounts, {profiles: null, loading: false, failed: true});
    // Another request starts from Loading… again, not from the failure.
    t.engine.menuClosed();
    t.engine.menuOpened();
    assert.deepEqual(t.model().accounts, {profiles: null, loading: true, failed: false});
    await t.answer('switch --list --json', ok('not json'));
    assert.equal(t.model().accounts.failed, true);
});

test('only the newest list reply counts', async () => {
    const t = setup();
    await openMenu(t);
    t.engine.menuClosed();
    t.engine.menuOpened();
    assert.equal(listCalls(t).length, 2);
    await t.answer('switch --list --json', fail('first'));
    assert.equal(t.model().accounts.loading, true);
    assert.equal(t.model().accounts.failed, false);
    await t.answer('switch --list --json', ok(PROFILES));
    assert.equal(t.model().accounts.profiles.length, 2);
});

test('a switch lists the profiles again once its follow-up answered', async () => {
    const t = setup();
    await openMenu(t);
    await t.answer('switch --list --json', ok(PROFILES));
    assert.equal(t.engine.runAction('switch', ['switch', '3c4d'], {id: '3c4d'}), true);
    assert.deepEqual(t.model().pending, {kind: 'switch', id: '3c4d'});
    await t.answer('switch 3c4d', ok());
    assert.equal(listCalls(t).length, 1);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().pending, null);
    assert.equal(listCalls(t).length, 2);
    await t.answer('switch --list --json', ok(PROFILES.replace('"selected": true', '"selected": null')));
    assert.equal(t.model().accounts.loading, false);
});

test('a switch lists the profiles again even when the menu is closed', async () => {
    const t = setup();
    await openMenu(t);
    await t.answer('switch --list --json', ok(PROFILES));
    t.engine.runAction('switch', ['switch', '3c4d'], {id: '3c4d'});
    t.engine.menuClosed();
    await t.answer('switch 3c4d', ok());
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(listCalls(t).length, 2);
});

test('an action that is not a switch does not list the profiles', async () => {
    const t = setup();
    await openMenu(t);
    await t.answer('switch --list --json', ok(PROFILES));
    t.engine.runAction('set', ['set', '--accept-dns=false'], {flag: 'accept-dns', value: false});
    await t.answer('set --accept-dns=false', ok());
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(listCalls(t).length, 1);
});

test('a failing switch whose follow-up reads Login required lists nothing until Running returns', async () => {
    for (const blocked of [STATUS.login, STATUS.approval]) {
        const t = setup();
        await openMenu(t);
        await t.answer('switch --list --json', ok(PROFILES));
        t.engine.runAction('switch', ['switch', '3c4d'], {id: '3c4d'});
        await t.answer('switch 3c4d', fail('needs login'));
        await t.answer('status --json', ok(blocked));
        assert.equal(t.model().actionError, null);
        assert.equal(listCalls(t).length, 1);
        // Back to Running with the menu still open and no new action: no error, one list.
        t.engine.requestRefresh();
        await t.answer('status --json', ok(STATUS.running));
        assert.equal(t.model().actionError, null);
        assert.equal(listCalls(t).length, 2);
        t.engine.requestRefresh();
        await t.answer('status --json', ok(STATUS.running));
        assert.equal(listCalls(t).length, 2);
    }
});

test('in Login required, opening the menu lists nothing', async () => {
    const t = setup();
    await openMenu(t, STATUS.login);
    t.engine.menuClosed();
    t.engine.menuOpened();
    assert.equal(listCalls(t).length, 0);
});

test('a list reply that arrives after destroy changes nothing', async () => {
    const t = setup();
    await openMenu(t);
    const seen = t.changes.length;
    t.engine.destroy();
    await t.answer('switch --list --json', ok(PROFILES));
    assert.equal(t.changes.length, seen);
    assert.equal(t.model().accounts.profiles, null);
    t.engine.menuOpened();
    assert.equal(listCalls(t).length, 1);
});

test('a refresh that is discarded does not list the profiles', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.login));
    t.engine.menuOpened();
    t.engine.runAction('up', ['up']);
    t.engine.requestRefresh();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().state.id, 'login');
    assert.equal(listCalls(t).length, 0);
});

test('only a successful refresh that counts is passed on for notifications', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', fail('failed to connect to local tailscaled'));
    assert.equal(t.good.length, 0);
    t.timers[0].callback();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.good.length, 1);
    assert.equal(t.good[0].state.id, 'connected');
    assert.equal(t.good[0].status.BackendState, 'Running');
    assert.equal(t.good[0].nowMs, 1_000_000);
    assert.equal(t.good[0].lastActionMs, null);
    // Not Unavailable, and not an unreadable answer either.
    t.timers[0].callback();
    await t.answer('status --json', ok('<html>not json</html>'));
    assert.equal(t.good.length, 1);
});

test('a discarded refresh is not passed on, and the action time is', async () => {
    const t = setup();
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.env.now = 1_005_000;
    t.engine.runAction('down', ['down']);
    t.engine.requestRefresh();
    // The stale read, still Running, is discarded while the action is pending.
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.good.length, 1);
    await t.answer('down', ok());
    await t.answer('status --json', ok(STATUS.stopped));
    assert.equal(t.good.length, 2);
    assert.equal(t.good[1].state.id, 'disconnected');
    assert.equal(t.good[1].lastActionMs, 1_005_000);
});

test('nothing is passed on after destroy', async () => {
    const t = setup();
    t.engine.start();
    t.engine.destroy();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.good.length, 0);
});

// --- Shares: tailscale serve status --json ----------------------------------------------------

const SERVE = JSON.stringify({
    TCP: {443: {HTTPS: true}, 5432: {TCPForward: '127.0.0.1:5432'}},
    Web: {'laptop.tail1234.ts.net:443': {Handlers: {'/': {Proxy: 'http://127.0.0.1:3000'}}}},
});
const STOPPED = {timedOut: true, exitCode: -1, stdout: '', stderr: ''};
const SERVE_STATUS = 'serve status --json';

test('serve status --json runs after get --json, in Connected only', async () => {
    const t = setup({manualGet: true, manualServe: true});
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    assert.deepEqual(names(t), ['status --json', 'get --json']);
    await t.answer('get --json', ok(GET));
    // The calls run one after the other: serve waited for get.
    assert.deepEqual(names(t), ['status --json', 'get --json', SERVE_STATUS]);
    assert.equal(t.calls[2].timeout, 30);
    assert.equal(t.model().loaded, false);
    await t.answer(SERVE_STATUS, ok(SERVE));
    assert.equal(t.model().loaded, true);
    assert.equal(t.model().shares.ok, true);
    assert.deepEqual(t.model().shares.shares.map(share => share.url),
        ['https://laptop.tail1234.ts.net', 'laptop.tail1234.ts.net:5432']);
});

test('serve status --json never runs outside Connected, nor when status failed', async () => {
    const answers = [
        ok(STATUS.stopped), ok(STATUS.login), ok(STATUS.approval), ok(STATUS_CONNECTING),
        fail('failed to connect to local tailscaled'), {missing: true, exitCode: -1, stdout: '', stderr: ''},
        ok('not json'),
    ];
    for (const answer of answers) {
        const t = setup({manualGet: true, manualServe: true});
        t.engine.start();
        await t.answer('status --json', answer);
        if (t.pending('get --json'))
            await t.answer('get --json', ok(GET));
        assert.equal(names(t).includes(SERVE_STATUS), false);
        assert.equal(t.model().shares, null);
    }
});

test('the shares go away when the state is no longer Connected', async () => {
    const t = setup();
    t.env.serve = ok(SERVE);
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().shares.shares.length, 2);
    t.timers[0].callback();
    await t.answer('status --json', ok(STATUS.stopped));
    assert.equal(t.model().shares, null);
    t.timers[0].callback();
    await t.answer('status --json', fail('failed to connect to local tailscaled'));
    assert.equal(t.model().shares, null);
});

test('a refresh known to be discarded does not read the shares', async () => {
    const t = setup({manualGet: true, manualServe: true});
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    await t.answer('get --json', ok(GET));
    await t.answer(SERVE_STATUS, ok(SERVE));
    // An action starts while status runs: neither get nor serve follow for that refresh.
    t.engine.requestRefresh();
    t.engine.runAction('down', ['down']);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(names(t).filter(name => name === SERVE_STATUS).length, 1);
    assert.equal(names(t).filter(name => name === 'get --json').length, 1);
    // An action started while get runs: serve does not follow for that refresh either.
    const u = setup({manualGet: true, manualServe: true});
    u.engine.start();
    await u.answer('status --json', ok(STATUS.running));
    u.engine.runAction('set', ['set', '--shields-up=true'], {flag: 'shields-up', value: true});
    await u.answer('get --json', ok(GET));
    assert.equal(names(u).includes(SERVE_STATUS), false);
});

test('a failing, timed out or unreadable share read keeps the refresh good and sets only the failure', async () => {
    const replies = [
        fail('boom'), STOPPED, ok('not json'), ok('[]'), ok('"text"'), ok(''),
        {missing: true, exitCode: -1, stdout: '', stderr: ''},
    ];
    for (const reply of replies) {
        const t = setup();
        t.env.serve = reply;
        t.engine.start();
        await t.answer('status --json', ok(STATUS.running));
        assert.equal(t.model().loaded, true);
        assert.equal(t.model().state.id, 'connected');
        assert.equal(t.model().refreshError, null);
        assert.equal(t.model().actionError, null);
        assert.equal(t.model().prefs['accept-dns'], true);
        assert.deepEqual(t.model().shares, {ok: false, shares: []});
        assert.equal(t.good.length, 1);
    }
});

test('null and {} are good reads with no share', async () => {
    for (const reply of ['null', '{}']) {
        const t = setup();
        t.env.serve = ok(reply);
        t.engine.start();
        await t.answer('status --json', ok(STATUS.running));
        assert.deepEqual(t.model().shares, {ok: true, shares: []});
    }
});

test('a failing get followed by a good share read shows the shares', async () => {
    const t = setup();
    t.env.get = fail('boom');
    t.env.serve = ok(SERVE);
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().prefs, null);
    assert.equal(t.model().shares.ok, true);
    assert.equal(t.model().shares.shares.length, 2);
});

test('a share read that answers after an action started changes nothing', async () => {
    const t = setup({manualServe: true});
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    t.engine.runAction('set', ['set', '--shields-up=true'], {flag: 'shields-up', value: true});
    await t.answer(SERVE_STATUS, ok(SERVE));
    assert.equal(t.model().loaded, false);
    assert.equal(t.model().shares, null);
    assert.equal(t.good.length, 0);
});

test('a share read that answers after destroy changes nothing and starts nothing', async () => {
    const t = setup({manualServe: true});
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    const seen = t.changes.length;
    t.engine.destroy();
    await t.answer(SERVE_STATUS, ok(SERVE));
    assert.equal(t.changes.length, seen);
    assert.equal(t.model().loaded, false);
    assert.equal(t.timers.length, 0);
    assert.equal(t.calls.filter(call => !call.done).length, 0);
});

test('stopping a share is an action: one command, then the follow-up, which shows the new shares', async () => {
    const t = setup();
    t.env.serve = ok(SERVE);
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    const [web] = t.model().shares.shares;
    const args = ['serve', '--https=443', '--set-path=/', 'off'];
    assert.equal(t.engine.runAction('stop', args, {key: web.key}), true);
    assert.deepEqual(t.model().pending, {kind: 'stop', key: web.key});
    // One action at a time.
    assert.equal(t.engine.runAction('down', ['down']), false);
    assert.equal(names(t).at(-1), args.join(' '));
    t.env.serve = ok(JSON.stringify({TCP: {5432: {TCPForward: '127.0.0.1:5432'}}}));
    await t.answer(args.join(' '), ok());
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().pending, null);
    assert.equal(t.model().actionError, null);
    assert.deepEqual(t.model().shares.shares.map(share => share.kind), ['tcp']);
    // The stop counts as an action for the Connection lost notification.
    assert.equal(t.good.at(-1).lastActionMs, 1_000_000);
});

test('a failing stop shows its error once the follow-up answered, and the row keeps its share', async () => {
    const t = setup();
    t.env.serve = ok(SERVE);
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    const args = ['serve', '--tcp=5432', 'off'];
    t.engine.runAction('stop', args, {key: t.model().shares.shares[1].key});
    await t.answer(args.join(' '), fail('Access denied: serve config denied'));
    assert.equal(t.model().actionError, null);
    await t.answer('status --json', ok(STATUS.running));
    assert.equal(t.model().actionError.text, 'Tailtray needs you to be the Tailscale operator.');
    assert.equal(t.model().shares.shares.length, 2);
});

test('a failing stop whose follow-up share read also fails shows the error and the failure', async () => {
    const t = setup();
    t.env.serve = ok(SERVE);
    t.engine.start();
    await t.answer('status --json', ok(STATUS.running));
    const args = ['serve', '--tcp=5432', 'off'];
    t.engine.runAction('stop', args, {key: t.model().shares.shares[1].key});
    t.env.serve = fail('boom');
    await t.answer(args.join(' '), fail(
        "must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket\nmore"));
    await t.answer('status --json', ok(STATUS.running));
    assert.match(t.model().actionError.text, /^must be root, or be an operator and able to run 'sudo tailscale'/);
    assert.equal(t.model().actionError.text.includes('more'), false);
    assert.deepEqual(t.model().shares, {ok: false, shares: []});
});
