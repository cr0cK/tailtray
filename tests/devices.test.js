import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    compareNames, deviceList, deviceName, deviceRows, firstAddress, magicDnsName, peerId, peersOf,
} from '../src/devices.js';

test('deviceName is the first label of the DNSName', () => {
    assert.equal(deviceName({DNSName: 'laptop.tail1234.ts.net.', HostName: 'other'}), 'laptop');
});

test('deviceName falls back to the HostName when the DNSName is empty or missing', () => {
    assert.equal(deviceName({DNSName: '', HostName: 'Desk-PC'}), 'Desk-PC');
    assert.equal(deviceName({HostName: 'Desk-PC'}), 'Desk-PC');
    assert.equal(deviceName({}), '');
});

test('compareNames ignores case', () => {
    const names = ['nas', 'Alpha', 'beta', 'Zulu'];
    assert.deepEqual(names.sort(compareNames), ['Alpha', 'beta', 'nas', 'Zulu']);
    assert.equal(compareNames('ABC', 'abc'), 0);
});

test('firstAddress picks the first address of the family', () => {
    const ips = ['fd7a:115c:a1e0::1', '100.64.0.1', '100.64.0.9'];
    assert.equal(firstAddress(ips, 4), '100.64.0.1');
    assert.equal(firstAddress(ips, 6), 'fd7a:115c:a1e0::1');
    assert.equal(firstAddress(['100.64.0.1'], 6), null);
    assert.equal(firstAddress(undefined, 4), null);
});

test('magicDnsName drops the trailing dot only', () => {
    assert.equal(magicDnsName({DNSName: 'laptop.tail1234.ts.net.'}), 'laptop.tail1234.ts.net');
    assert.equal(magicDnsName({DNSName: 'laptop'}), 'laptop');
    assert.equal(magicDnsName({}), '');
});

test('deviceRows lists the name, the IPv4 and the IPv6 address', () => {
    const rows = deviceRows({
        DNSName: 'laptop.tail1234.ts.net.',
        TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
    });
    assert.deepEqual(rows, [
        {id: 'dns', value: 'laptop.tail1234.ts.net'},
        {id: 'ipv4', value: '100.64.0.1'},
        {id: 'ipv6', value: 'fd7a:115c:a1e0::1'},
    ]);
});

test('deviceRows hides a row whose value is missing', () => {
    assert.deepEqual(
        deviceRows({DNSName: 'a.tail1234.ts.net.', TailscaleIPs: ['100.64.0.1']}).map(row => row.id),
        ['dns', 'ipv4']
    );
    assert.deepEqual(
        deviceRows({DNSName: '', TailscaleIPs: ['fd7a:115c:a1e0::1']}).map(row => row.id),
        ['ipv6']
    );
});

test('deviceRows is empty with no value at all', () => {
    assert.deepEqual(deviceRows({}), []);
    assert.deepEqual(deviceRows(undefined), []);
    assert.deepEqual(deviceRows({DNSName: '', TailscaleIPs: []}), []);
});

const NOW = Date.parse('2026-11-02T15:00:00Z');
const peer = (name, extra = {}) => ({
    ID: `n${name}`,
    HostName: name,
    DNSName: `${name}.tail1234.ts.net.`,
    OS: 'linux',
    TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0::2'],
    Online: true,
    LastSeen: '2026-11-02T14:00:00Z',
    ...extra,
});
const statusOf = peers => ({Peer: Object.fromEntries(peers.map(p => [`nodekey:${p.ID}`, p]))});

test('deviceList puts online devices first, each group sorted by name ignoring case', () => {
    const list = deviceList(statusOf([
        peer('zulu'), peer('Beta', {Online: false}), peer('alpha', {Online: false}),
        peer('Charlie'), peer('bravo'),
    ]), NOW);
    assert.deepEqual(list.devices.map(device => device.name), ['bravo', 'Charlie', 'zulu', 'alpha', 'Beta']);
    assert.deepEqual(list.devices.map(device => device.online), [true, true, true, false, false]);
});

test('deviceList leaves out peers with a Location, and keeps those without', () => {
    const list = deviceList(statusOf([
        peer('nas'),
        peer('mullvad-fr', {Location: {Country: 'France', CountryCode: 'FR', City: 'Paris'}}),
        peer('phone', {Location: null}),
    ]), NOW);
    assert.deepEqual(list.devices.map(device => device.name), ['nas', 'phone']);
    assert.equal(list.caption, 'Other devices · 2 of 2 online');
});

test('deviceList counts the online devices among those it lists', () => {
    const list = deviceList(statusOf([
        peer('a'), peer('b', {Online: false}), peer('c'),
        peer('mullvad-fr', {Location: {City: 'Paris'}}),
    ]), NOW);
    assert.equal(list.caption, 'Other devices · 2 of 3 online');
    // Only the title takes the accent colour, the count stays dim.
    assert.equal(list.title, 'Other devices');
    assert.equal(list.count, ' · 2 of 3 online');
});

test('deviceList says No other devices when nothing is listed', () => {
    const empty = {caption: 'No other devices', title: 'No other devices', count: '', devices: []};
    assert.deepEqual(deviceList({Peer: {}}, NOW), empty);
    assert.deepEqual(deviceList({}, NOW), empty);
    assert.deepEqual(deviceList(null, NOW), empty);
    const onlyMullvad = statusOf([peer('mullvad-fr', {Location: {City: 'Paris'}})]);
    assert.equal(deviceList(onlyMullvad, NOW).caption, 'No other devices');
});

test('deviceList names a device by its DNSName, else its HostName', () => {
    const list = deviceList(statusOf([
        peer('named'), peer('x', {DNSName: '', HostName: 'Desk-PC'}), peer('y', {DNSName: undefined, HostName: undefined}),
    ]), NOW);
    assert.deepEqual(list.devices.map(device => device.name), ['', 'Desk-PC', 'named']);
});

test('deviceList shows the OS of an online device and the last seen time of an offline one', () => {
    const list = deviceList(statusOf([
        peer('on', {OS: 'macOS'}),
        peer('off', {Online: false, OS: 'android', LastSeen: '2026-10-30T15:00:00Z'}),
        peer('never', {Online: false, LastSeen: '0001-01-01T00:00:00Z'}),
        peer('noos', {OS: undefined}),
    ]), NOW);
    const details = Object.fromEntries(list.devices.map(device => [device.name, device.detail]));
    assert.deepEqual(details, {on: 'macOS', noos: '', off: '3 days ago', never: ''});
});

test('deviceList gives the copyable rows and whether the device can be pinged', () => {
    const list = deviceList(statusOf([
        peer('full'),
        peer('v6only', {TailscaleIPs: ['fd7a:115c:a1e0::9']}),
        peer('offline', {Online: false}),
        peer('noaddress', {TailscaleIPs: []}),
    ]), NOW);
    const byName = Object.fromEntries(list.devices.map(device => [device.name, device]));
    assert.deepEqual(byName.full.rows.map(row => row.id), ['dns', 'ipv4', 'ipv6']);
    assert.equal(byName.full.address, '100.64.0.2');
    assert.equal(byName.full.canPing, true);
    assert.deepEqual(byName.v6only.rows.map(row => row.id), ['dns', 'ipv6']);
    assert.equal(byName.v6only.address, '');
    assert.equal(byName.v6only.canPing, false);
    assert.equal(byName.offline.address, '100.64.0.2');
    assert.equal(byName.offline.canPing, false);
    assert.deepEqual(byName.noaddress.rows.map(row => row.id), ['dns']);
    assert.equal(byName.noaddress.canPing, false);
});

test('deviceList identifies a device by its ID, else its key, and survives odd peers', () => {
    const status = {Peer: {'nodekey:k1': {DNSName: 'a.tail1234.ts.net.', Online: true}, 'nodekey:k2': null, 'nodekey:k3': 7}};
    assert.deepEqual(deviceList(status, NOW).devices.map(device => device.id), ['nodekey:k1']);
    assert.deepEqual(peersOf({Peer: [1]}), []);
    assert.equal(peerId('nodekey:k', {ID: ''}), 'nodekey:k');
    assert.equal(peerId('nodekey:k', {ID: 'n1'}), 'n1');
});
