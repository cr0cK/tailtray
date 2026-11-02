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
const ok = (stdout = '') => ({exitCode: 0, stdout, stderr: ''});
const fail = (stderr, fields = {}) => ({exitCode: 1, stdout: '', stderr, ...fields});

/** An engine whose commands and timers the test resolves by hand. */
function setup({interval = 10} = {}) {
    const calls = [];
    const timers = [];
    const changes = [];
    let nextId = 1;
    const env = {interval, now: 1_000_000};
    const engine = new Engine({
        run: (args, timeout) => new Promise(resolve => {
            calls.push({args, timeout, resolve, name: args.join(' ')});
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
    return {engine, calls, timers, changes, env, answer, pending, tick, model: () => engine.model};
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
