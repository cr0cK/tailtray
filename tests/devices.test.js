import assert from 'node:assert/strict';
import {test} from 'node:test';

import {compareNames, deviceName, deviceRows, firstAddress, magicDnsName} from '../src/devices.js';

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
