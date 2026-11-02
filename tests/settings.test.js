import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {LAN_ACCESS, parsePrefs, setArguments, settingRows, switchRow} from '../src/settings.js';

const GET = readFileSync(new URL('fixtures/get.json', import.meta.url), 'utf8');
const ok = stdout => ({exitCode: 0, stdout, stderr: ''});

test('parsePrefs keeps the boolean preferences', () => {
    const prefs = parsePrefs(ok(GET));
    assert.equal(prefs['accept-dns'], true);
    assert.equal(prefs['accept-routes'], false);
    assert.equal(prefs['shields-up'], false);
    // Text values are not switches.
    assert.equal('hostname' in prefs, false);
});

test('parsePrefs gives null when the read failed or printed something else', () => {
    assert.equal(parsePrefs({exitCode: 1, stdout: '', stderr: 'boom'}), null);
    assert.equal(parsePrefs({missing: true, exitCode: -1, stdout: '', stderr: ''}), null);
    assert.equal(parsePrefs({timedOut: true, exitCode: -1, stdout: '{}', stderr: ''}), null);
    assert.equal(parsePrefs(ok('')), null);
    assert.equal(parsePrefs(ok('not json')), null);
    assert.equal(parsePrefs(ok('[true]')), null);
    assert.equal(parsePrefs(ok('null')), null);
});

test('setArguments builds the tailscale set arguments', () => {
    assert.deepEqual(setArguments('accept-routes', true), ['set', '--accept-routes=true']);
    assert.deepEqual(setArguments('shields-up', false), ['set', '--shields-up=false']);
});

test('settingRows shows the three switches with the values get returned', () => {
    assert.deepEqual(settingRows(parsePrefs(ok(GET)), null), [
        {id: 'accept-routes', label: 'Use Tailscale subnets', value: false, sensitive: true},
        {id: 'accept-dns', label: 'Use Tailscale DNS', value: true, sensitive: true},
        {id: 'shields-up', label: 'Block incoming connections', value: false, sensitive: true},
    ]);
});

test('a missing key makes only that switch insensitive', () => {
    const rows = settingRows({'accept-dns': true, 'shields-up': true}, null);
    assert.deepEqual(rows.map(row => row.sensitive), [false, true, true]);
    assert.equal(rows[0].value, false);
});

test('a failed read makes every switch insensitive', () => {
    const rows = settingRows(null, null);
    assert.deepEqual(rows.map(row => row.sensitive), [false, false, false]);
});

test('a pending action locks every switch, and a set shows the requested value', () => {
    const prefs = parsePrefs(ok(GET));
    const rows = settingRows(prefs, {kind: 'set', flag: 'shields-up', value: true});
    assert.deepEqual(rows.map(row => row.sensitive), [false, false, false]);
    assert.deepEqual(rows.map(row => row.value), [false, true, true]);
    // Another kind of action leaves the values alone.
    const other = settingRows(prefs, {kind: 'switch', id: '1a2b'});
    assert.deepEqual(other.map(row => row.value), [false, true, false]);
    assert.deepEqual(other.map(row => row.sensitive), [false, false, false]);
});

test('Allow LAN access is a switch row like the others', () => {
    const prefs = {'exit-node-allow-lan-access': true};
    assert.deepEqual(switchRow(prefs, null, LAN_ACCESS), {
        id: 'exit-node-allow-lan-access', label: 'Allow LAN access', value: true, sensitive: true,
    });
    assert.equal(switchRow({}, null, LAN_ACCESS).sensitive, false);
    assert.equal(switchRow(null, null, LAN_ACCESS).sensitive, false);
    const pending = {kind: 'set', flag: 'exit-node-allow-lan-access', value: false};
    assert.deepEqual(switchRow(prefs, pending, LAN_ACCESS).value, false);
    assert.equal(switchRow(prefs, pending, LAN_ACCESS).sensitive, false);
    // An exit node action locks it without touching its value.
    const locked = switchRow(prefs, {kind: 'exit', target: 'n1'}, LAN_ACCESS);
    assert.deepEqual([locked.value, locked.sensitive], [true, false]);
});
