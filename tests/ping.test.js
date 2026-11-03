import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {Pinger, PING_TIMEOUT_SECONDS, pingArguments, pingText} from '../src/ping.js';

const fixtures = JSON.parse(readFileSync(new URL('fixtures/ping.json', import.meta.url), 'utf8'));
const result = (name, extra = {}) => ({
    missing: false, timedOut: false, exitCode: 0, stdout: '', stderr: '', ...fixtures[name], ...extra,
});

test('the ping arguments ask for one reply and do not wait for a direct path', () => {
    assert.deepEqual(pingArguments('100.64.0.2'),
        ['ping', '-c', '1', '--until-direct=false', '--timeout', '5s', '100.64.0.2']);
});

test('a direct pong shows its latency', () => {
    assert.equal(pingText(result('direct')), 'direct · 36 ms');
    assert.equal(pingText(result('direct-ipv6')), 'direct · 23 ms');
});

test('a DERP pong shows its region', () => {
    assert.equal(pingText(result('derp')), 'relay nyc · 26 ms');
});

test('a peer relay pong says so', () => {
    assert.equal(pingText(result('peer-relay')), 'peer relay · 31 ms');
});

test('a pong wins over a non-zero exit code', () => {
    assert.equal(pingText(result('derp-until-direct')), 'relay nyc · 41 ms');
    assert.equal(pingText(result('direct', {exitCode: 1})), 'direct · 36 ms');
    // Even when the time limit killed the command after the pong.
    assert.equal(pingText(result('direct', {timedOut: true, exitCode: -1})), 'direct · 36 ms');
});

test('a ping without a pong is no answer when it timed out, or error otherwise', () => {
    assert.equal(pingText(result('timeout')), 'no answer');
    assert.equal(pingText({...result('timeout'), stdout: ''}), 'no answer');
    assert.equal(pingText({...result('timeout'), stdout: 'ping "100.64.0.2" timed out\n', stderr: ''}),
        'no answer');
    // Killed by Tailtray's own time limit.
    assert.equal(pingText({missing: false, timedOut: true, exitCode: -1, stdout: '', stderr: ''}),
        'no answer');
    assert.equal(pingText(result('no-peer')), 'error');
});

test('garbage, a missing command, and a silent failure are errors', () => {
    assert.equal(pingText(result('garbage')), 'error');
    assert.equal(pingText({missing: true, timedOut: false, exitCode: -1, stdout: '', stderr: ''}), 'error');
    assert.equal(pingText({missing: false, timedOut: false, exitCode: 1, stdout: '', stderr: ''}), 'error');
});

test('latencies are rounded to whole milliseconds, whatever the Go duration looks like', () => {
    const pong = latency => ({
        missing: false, timedOut: false, exitCode: 0, stderr: '',
        stdout: `pong from nas (100.64.0.2) via 192.0.2.10:41641 in ${latency}\n`,
    });
    assert.equal(pingText(pong('0s')), 'direct · 0 ms');
    assert.equal(pingText(pong('1.234s')), 'direct · 1234 ms');
    assert.equal(pingText(pong('1m2.5s')), 'direct · 62500 ms');
    assert.equal(pingText(pong('1.5ms')), 'direct · 2 ms');
    assert.equal(pingText(pong('999µs')), 'direct · 1 ms');
});

test('a pong with an empty region, or a node name with spaces and parentheses, still reads', () => {
    const stdout = 'pong from Desk (main) (100.64.0.2) via DERP() in 9ms\n';
    assert.equal(pingText({exitCode: 0, stdout, stderr: ''}), 'relay · 9 ms');
});

// A scripted command: start() hands out one controllable run per call.
function harness() {
    const runs = [];
    const changes = [];
    const pinger = new Pinger({
        start: (args, timeoutSeconds) => {
            const run = {args, timeoutSeconds, killed: false};
            run.result = new Promise(resolve => {
                run.finish = value => resolve(value);
            });
            run.kill = () => {
                run.killed = true;
                // A killed command still ends, with no output.
                run.finish({missing: false, timedOut: false, exitCode: -1, stdout: '', stderr: ''});
            };
            runs.push(run);
            return run;
        },
        onChange: () => changes.push(true),
    });
    return {pinger, runs, changes};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a ping runs with the 10 second limit and shows … then its result', async () => {
    const {pinger, runs} = harness();
    assert.equal(pinger.text('a'), '');
    assert.equal(pinger.ping('a', '100.64.0.2'), true);
    assert.equal(pinger.text('a'), '…');
    assert.deepEqual(runs[0].args, pingArguments('100.64.0.2'));
    assert.equal(runs[0].timeoutSeconds, PING_TIMEOUT_SECONDS);
    runs[0].finish(result('direct'));
    await tick();
    assert.equal(pinger.text('a'), 'direct · 36 ms');
});

test('a second ping on a device whose ping runs does nothing, and one after its result runs', async () => {
    const {pinger, runs} = harness();
    pinger.ping('a', '100.64.0.2');
    assert.equal(pinger.ping('a', '100.64.0.2'), false);
    assert.equal(runs.length, 1);
    runs[0].finish(result('direct'));
    await tick();
    assert.equal(pinger.ping('a', '100.64.0.2'), true);
    assert.equal(pinger.text('a'), '…');
    assert.equal(runs.length, 2);
});

test('two devices ping at once and each keeps its own result', async () => {
    const {pinger, runs} = harness();
    pinger.ping('a', '100.64.0.2');
    pinger.ping('b', '100.64.0.3');
    assert.equal(runs.length, 2);
    runs[1].finish(result('derp'));
    await tick();
    assert.equal(pinger.text('a'), '…');
    assert.equal(pinger.text('b'), 'relay nyc · 26 ms');
    runs[0].finish(result('timeout'));
    await tick();
    assert.equal(pinger.text('a'), 'no answer');
    assert.equal(pinger.text('b'), 'relay nyc · 26 ms');
});

test('reset kills the pings that run and clears every result, and a killed ping never shows', async () => {
    const {pinger, runs, changes} = harness();
    pinger.ping('a', '100.64.0.2');
    pinger.ping('b', '100.64.0.3');
    runs[1].finish(result('direct'));
    await tick();
    changes.length = 0;
    pinger.reset();
    await tick();
    assert.deepEqual(runs.map(run => run.killed), [true, false]);
    assert.equal(pinger.text('a'), '');
    assert.equal(pinger.text('b'), '');
    assert.equal(changes.length, 0);
    // The device can be pinged again, and the old reply cannot land on the new ping.
    pinger.ping('a', '100.64.0.2');
    assert.equal(pinger.text('a'), '…');
    runs[0].finish(result('direct'));
    await tick();
    assert.equal(pinger.text('a'), '…');
});

test('forget drops one device only', async () => {
    const {pinger, runs} = harness();
    pinger.ping('a', '100.64.0.2');
    pinger.ping('b', '100.64.0.3');
    pinger.forget('a');
    await tick();
    assert.deepEqual(runs.map(run => run.killed), [true, false]);
    assert.equal(pinger.text('a'), '');
    assert.equal(pinger.text('b'), '…');
    pinger.forget('unknown');
});

test('after destroy nothing starts and no reply is shown or announced', async () => {
    const {pinger, runs, changes} = harness();
    pinger.ping('a', '100.64.0.2');
    pinger.destroy();
    await tick();
    assert.equal(runs[0].killed, true);
    changes.length = 0;
    assert.equal(pinger.ping('b', '100.64.0.3'), false);
    assert.equal(runs.length, 1);
    assert.equal(changes.length, 0);
    assert.equal(pinger.text('a'), '');
});
