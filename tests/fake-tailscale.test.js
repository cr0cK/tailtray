import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const fake = join(root, 'scripts/fake-tailscale');

/** A scratch directory for the fake with the running status, and a runner of the fake. */
function setup(serve = null) {
    const dir = mkdtempSync(join(tmpdir(), 'tailtray-fake-'));
    copyFileSync(join(root, 'tests/fixtures/status-running.json'), join(dir, 'status.json'));
    if (serve !== null)
        writeFileSync(join(dir, 'serve.json'), typeof serve === 'string' ? serve : JSON.stringify(serve));
    const run = (...args) => spawnSync('python3', [fake, ...args], {
        env: {...process.env, TAILTRAY_FAKE_DIR: dir}, encoding: 'utf8',
    });
    const config = () => JSON.parse(readFileSync(join(dir, 'serve.json'), 'utf8'));
    const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return {dir, run, config, calls, write: (name, text) => writeFileSync(join(dir, name), text)};
}

const HOST = 'laptop.tail1234.ts.net';
const config = () => ({
    TCP: {
        443: {HTTPS: true}, 4173: {HTTP: true}, 5432: {TCPForward: '127.0.0.1:5432'},
        8443: {TCPForward: '127.0.0.1:9000', TerminateTLS: HOST},
    },
    Web: {
        [`${HOST}:443`]: {Handlers: {'/a': {Proxy: 'x'}, '/b': {Proxy: 'y'}}},
        [`${HOST}:4173`]: {Handlers: {'/': {Proxy: 'z'}}},
    },
    AllowFunnel: {[`${HOST}:443`]: true, [`${HOST}:4173`]: true},
    Foreground: {s: {TCP: {80: {HTTP: true}}, Web: {[`${HOST}:80`]: {Handlers: {'/': {Proxy: 'w'}}}}}},
});

test('serve status prints null without serve.json, and the file as it was otherwise', () => {
    const empty = setup();
    assert.equal(empty.run('serve', 'status', '--json').stdout.trim(), 'null');
    const full = setup(config());
    assert.deepEqual(JSON.parse(full.run('serve', 'status', '--json').stdout), config());
    assert.deepEqual(full.calls().map(call => call.key), ['serve-status']);
    for (const {dir} of [empty, full])
        rmSync(dir, {recursive: true});
});

test('serve status and serve off honor .stdout, .fail and .sleep control keys', () => {
    const t = setup(config());
    t.write('serve-status.stdout', 'garbage');
    assert.equal(t.run('serve', 'status', '--json').stdout, 'garbage');
    t.write('serve-status.fail', '3\n');
    t.write('serve-status.stderr', 'nope\n');
    const failed = t.run('serve', 'status', '--json');
    assert.equal(failed.status, 3);
    assert.equal(failed.stderr.trim(), 'nope');
    t.write('serve-off.fail', '1\n');
    assert.equal(t.run('serve', '--tcp=5432', 'off').status, 1);
    assert.deepEqual(t.config(), config());
    // .noeffect succeeds and leaves the file as it is.
    rmSync(join(t.dir, 'serve-off.fail'));
    t.write('serve-off.noeffect', '1\n');
    assert.equal(t.run('serve', '--tcp=5432', 'off').status, 0);
    assert.deepEqual(t.config(), config());
    rmSync(t.dir, {recursive: true});
});

test('off removes one mount of a Web share, and the port with its last handler', () => {
    const t = setup(config());
    assert.equal(t.run('serve', '--https=443', '--set-path=/a', 'off').status, 0);
    let now = t.config();
    assert.deepEqual(Object.keys(now.Web[`${HOST}:443`].Handlers), ['/b']);
    assert.ok(now.TCP[443]);
    assert.equal(now.AllowFunnel[`${HOST}:443`], true);
    assert.equal(t.run('serve', '--https=443', '--set-path=/b', 'off').status, 0);
    now = t.config();
    assert.equal(now.Web[`${HOST}:443`], undefined);
    assert.equal(now.TCP[443], undefined);
    assert.equal(now.AllowFunnel[`${HOST}:443`], undefined);
    // The other port and the foreground config are untouched.
    assert.ok(now.Web[`${HOST}:4173`]);
    assert.deepEqual(now.Foreground, config().Foreground);
    rmSync(t.dir, {recursive: true});
});

test('off of a TCP share removes only its TCP entry, TLS-terminated or not, and keeps AllowFunnel', () => {
    const t = setup({...config(), AllowFunnel: {[`${HOST}:5432`]: true}});
    assert.equal(t.run('serve', '--tcp=5432', 'off').status, 0);
    assert.equal(t.run('serve', '--tls-terminated-tcp=8443', 'off').status, 0);
    const now = t.config();
    assert.equal(now.TCP[5432], undefined);
    assert.equal(now.TCP[8443], undefined);
    assert.ok(now.TCP[443] && now.TCP[4173]);
    assert.deepEqual(now.AllowFunnel, {[`${HOST}:5432`]: true});
    rmSync(t.dir, {recursive: true});
});

test('off without --set-path removes every mount of the port', () => {
    const t = setup(config());
    assert.equal(t.run('serve', '--https=443', 'off').status, 0);
    assert.equal(t.config().Web[`${HOST}:443`], undefined);
    rmSync(t.dir, {recursive: true});
});

test('off exits 1 with Tailscale\'s error when nothing matches', () => {
    const t = setup(config());
    const web = [
        ['--https=443', '--set-path=/nope'], ['--http=443', '--set-path=/a'], ['--https=9999', '--set-path=/'],
        ['--https=80', '--set-path=/'], ['--https=4173', '--set-path=/'],
    ];
    for (const flags of web) {
        const result = t.run('serve', ...flags, 'off');
        assert.equal(result.status, 1, flags.join(' '));
        assert.equal(result.stderr.trim(), 'error: failed to remove web serve: handler does not exist');
    }
    for (const flag of ['--tcp=9999', '--tcp=443', '--tls-terminated-tcp=7']) {
        const result = t.run('serve', flag, 'off');
        assert.equal(result.status, 1, flag);
        assert.equal(result.stderr.trim(), 'error: failed to remove TCP serve: serve config does not exist');
    }
    assert.deepEqual(t.config(), config());
    // Without any serve.json there is nothing to remove either.
    const none = setup();
    assert.equal(none.run('serve', '--tcp=1', 'off').status, 1);
    rmSync(t.dir, {recursive: true});
    rmSync(none.dir, {recursive: true});
});

test('this device\'s name is the Self.DNSName of status.json without its dot', () => {
    const t = setup({
        TCP: {443: {HTTPS: true}},
        Web: {'other.tail1234.ts.net:443': {Handlers: {'/': {Proxy: 'x'}}}},
    });
    assert.equal(t.run('serve', '--https=443', '--set-path=/', 'off').status, 1);
    rmSync(t.dir, {recursive: true});
});

test('any other serve command is unknown', () => {
    const t = setup(config());
    assert.equal(t.run('serve', 'reset').status, 2);
    assert.equal(t.run('serve', '--bg', '3000').status, 2);
    rmSync(t.dir, {recursive: true});
});
