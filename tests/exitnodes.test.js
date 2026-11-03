import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {exitNodeArguments, exitNodeInUse, exitNodeRows} from '../src/exitnodes.js';

const RUNNING = JSON.parse(readFileSync(new URL('fixtures/status-running.json', import.meta.url), 'utf8'));

function peer(id, name, extra = {}) {
    return {
        ID: id,
        HostName: name,
        DNSName: `${name}.tail1234.ts.net.`,
        TailscaleIPs: ['100.64.0.10'],
        Online: true,
        ExitNode: false,
        ExitNodeOption: true,
        ...extra,
    };
}

const statusOf = (...peers) => ({Peer: Object.fromEntries(peers.map(p => [`nodekey:${p.ID}`, p]))});
const names = rows => rows.nodes.map(node => node.name);

test('only peers that are exit node options or in use are listed, sorted by name ignoring case', () => {
    const rows = exitNodeRows(statusOf(
        peer('n1', 'tokyo'),
        peer('n2', 'Berlin'),
        peer('n3', 'oslo', {ExitNodeOption: false}),
        peer('n4', 'paris'),
        peer('n5', 'rome', {ExitNodeOption: false, ExitNode: true})
    ), null);
    assert.deepEqual(names(rows), ['Berlin', 'paris', 'rome', 'tokyo']);
});

test('a peer with a Location (a Mullvad exit node) is listed like any other', () => {
    const rows = exitNodeRows(statusOf(
        peer('n1', 'de-ber-wg-001', {Location: {Country: 'Germany', City: 'Berlin'}}),
        peer('n2', 'paris')
    ), null);
    assert.deepEqual(names(rows), ['de-ber-wg-001', 'paris']);
});

test('the fixture lists its one exit node option and leaves the phone out', () => {
    const rows = exitNodeRows(RUNNING, null);
    assert.deepEqual(names(rows), ['nas']);
    assert.equal(rows.summary, 'None');
});

test('with no exit node in use, None is checked and no peer is', () => {
    const rows = exitNodeRows(statusOf(peer('n1', 'paris')), null);
    assert.equal(rows.none.checked, true);
    assert.deepEqual(rows.nodes.map(node => node.checked), [false]);
    assert.equal(rows.summary, 'None');
});

test('the exit node in use is checked and named on the row, None is not', () => {
    const rows = exitNodeRows(statusOf(peer('n1', 'paris'), peer('n2', 'tokyo', {ExitNode: true})), null);
    assert.equal(rows.none.checked, false);
    assert.deepEqual(rows.nodes.map(node => node.checked), [false, true]);
    assert.equal(rows.summary, 'tokyo');
});

test('the node in use stays listed and checked without ExitNodeOption', () => {
    const rows = exitNodeRows(statusOf(peer('n1', 'paris', {ExitNodeOption: false, ExitNode: true})), null);
    assert.deepEqual(rows.nodes.map(node => [node.name, node.checked]), [['paris', true]]);
    assert.equal(rows.available, true);
    assert.equal(rows.summary, 'paris');
});

test('an offline peer is insensitive unless it is the one in use', () => {
    const rows = exitNodeRows(statusOf(
        peer('n1', 'a-online'),
        peer('n2', 'b-offline', {Online: false}),
        peer('n3', 'c-offline-in-use', {Online: false, ExitNode: true})
    ), null);
    assert.deepEqual(rows.nodes.map(node => [node.name, node.online, node.sensitive]), [
        ['a-online', true, true],
        ['b-offline', false, false],
        ['c-offline-in-use', false, true],
    ]);
    assert.equal(rows.summary, 'c-offline-in-use');
});

test('the address is the first IPv4 one, else the first IPv6 one', () => {
    const rows = exitNodeRows(statusOf(
        peer('n1', 'both', {TailscaleIPs: ['fd7a:115c:a1e0::5', '100.64.0.5']}),
        peer('n2', 'six', {TailscaleIPs: ['fd7a:115c:a1e0::6']})
    ), null);
    assert.deepEqual(rows.nodes.map(node => node.address), ['100.64.0.5', 'fd7a:115c:a1e0::6']);
    assert.deepEqual(rows.nodes.map(node => node.sensitive), [true, true]);
});

test('a peer with no address is insensitive, even the one in use', () => {
    const rows = exitNodeRows(statusOf(
        peer('n1', 'none', {TailscaleIPs: []}),
        peer('n2', 'missing', {TailscaleIPs: undefined, ExitNode: true})
    ), null);
    assert.deepEqual(rows.nodes.map(node => [node.address, node.sensitive]), [['', false], ['', false]]);
});

test('None available only with no option and none in use', () => {
    for (const status of [{}, {Peer: {}}, {Peer: null}, statusOf(peer('n1', 'phone', {ExitNodeOption: false}))]) {
        const rows = exitNodeRows(status, null);
        assert.equal(rows.available, false);
        assert.equal(rows.summary, 'None available');
        assert.deepEqual(rows.nodes, []);
    }
    assert.equal(exitNodeRows(statusOf(peer('n1', 'paris')), null).available, true);
});

test('a peer without ID is keyed by its Peer entry', () => {
    const status = {Peer: {'nodekey:xyz': {HostName: 'paris', ExitNodeOption: true, TailscaleIPs: ['100.64.0.9']}}};
    assert.equal(exitNodeRows(status, null).nodes[0].id, 'nodekey:xyz');
    assert.deepEqual(exitNodeInUse({Peer: {'nodekey:xyz': {HostName: 'paris', ExitNode: true}}}),
        {id: 'nodekey:xyz', name: 'paris'});
});

test('names that compare equal keep a stable order by id', () => {
    const rows = exitNodeRows(statusOf(peer('n2', 'Paris'), peer('n1', 'paris')), null);
    assert.deepEqual(rows.nodes.map(node => node.id), ['n1', 'n2']);
});

test('while an action is pending every row is insensitive and the target shows Setting…', () => {
    const status = statusOf(peer('n1', 'paris'), peer('n2', 'tokyo'));
    const rows = exitNodeRows(status, {kind: 'exit', target: 'n2'});
    assert.deepEqual(rows.nodes.map(node => [node.sensitive, node.progress]), [[false, ''], [false, 'Setting…']]);
    assert.deepEqual(rows.none, {checked: true, sensitive: false, progress: ''});
    const none = exitNodeRows(status, {kind: 'exit', target: ''});
    assert.equal(none.none.progress, 'Setting…');
    assert.deepEqual(none.nodes.map(node => node.progress), ['', '']);
    // Another kind of action locks the rows without showing progress on them.
    const other = exitNodeRows(status, {kind: 'set', flag: 'shields-up', value: true});
    assert.deepEqual(other.nodes.map(node => [node.sensitive, node.progress]), [[false, ''], [false, '']]);
    assert.equal(other.none.sensitive, false);
});

test('exitNodeArguments sets the address, or nothing for None', () => {
    assert.deepEqual(exitNodeArguments('100.64.0.2'), ['set', '--exit-node=100.64.0.2']);
    assert.deepEqual(exitNodeArguments('fd7a:115c:a1e0::2'), ['set', '--exit-node=fd7a:115c:a1e0::2']);
    assert.deepEqual(exitNodeArguments(''), ['set', '--exit-node=']);
});
