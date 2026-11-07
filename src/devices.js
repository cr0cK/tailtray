import {relativeTime} from './time.js';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The first address of a family in a list of Tailscale IPs, or null. */
export function firstAddress(addresses, family) {
    if (!Array.isArray(addresses))
        return null;
    const wanted = family === 4
        ? address => typeof address === 'string' && IPV4.test(address)
        : address => typeof address === 'string' && address.includes(':');
    return addresses.find(wanted) ?? null;
}

/** A MagicDNS name without its trailing dot, or an empty string. */
export function magicDnsName(node) {
    const name = node?.DNSName;
    return typeof name === 'string' ? name.replace(/\.$/, '') : '';
}

/** A device's name: the first label of its DNSName, or its HostName when that is empty. */
export function deviceName(node) {
    const first = magicDnsName(node).split('.')[0];
    if (first !== '')
        return first;
    return typeof node?.HostName === 'string' ? node.HostName : '';
}

/** Case-insensitive comparison of two device names, for Array.sort. */
export function compareNames(first, second) {
    const a = first.toLowerCase();
    const b = second.toLowerCase();
    if (a < b)
        return -1;
    return a > b ? 1 : 0;
}

/**
 * The copyable rows of a device, in order: its MagicDNS name, first IPv4 and first IPv6
 * address. A missing value has no row. Each row is {id, value}.
 */
export function deviceRows(node) {
    const rows = [
        {id: 'dns', value: magicDnsName(node)},
        {id: 'ipv4', value: firstAddress(node?.TailscaleIPs, 4) ?? ''},
        {id: 'ipv6', value: firstAddress(node?.TailscaleIPs, 6) ?? ''},
    ];
    return rows.filter(row => row.value !== '');
}

/** The peers of a status as `[key, peer]` pairs, skipping anything that is not an object. */
export function peersOf(status) {
    const peers = status?.Peer;
    if (peers === null || typeof peers !== 'object' || Array.isArray(peers))
        return [];
    return Object.entries(peers).filter(([, peer]) => peer !== null && typeof peer === 'object');
}

/** A peer's row id: its `ID`, else its key in `Peer`. */
export function peerId(key, peer) {
    return typeof peer.ID === 'string' && peer.ID !== '' ? peer.ID : key;
}

/**
 * The Other devices section. Returns `{caption, devices}`, where `devices` has one
 * `{id, name, online, detail, rows, address, canPing}` per peer except those with a `Location`
 * (Mullvad exit nodes), online ones first, each group sorted by name. `detail` is the OS of an
 * online peer or how long ago an offline one was seen, `rows` its copyable values (see
 * deviceRows), `address` its first IPv4 address or '', and `canPing` whether it is online and
 * has one. The caption counts the listed devices; `title` is its first part, which the menu shows
 * in the accent colour, and `count` the rest, which stays dim.
 */
export function deviceList(status, nowMs) {
    const devices = peersOf(status)
        .filter(([, peer]) => peer.Location === undefined || peer.Location === null)
        .map(([key, peer]) => {
            const online = peer.Online === true;
            const address = firstAddress(peer.TailscaleIPs, 4) ?? '';
            return {
                id: peerId(key, peer),
                name: deviceName(peer),
                online,
                detail: online
                    ? (typeof peer.OS === 'string' ? peer.OS : '')
                    : relativeTime(peer.LastSeen, nowMs),
                rows: deviceRows(peer),
                address,
                canPing: online && address !== '',
            };
        })
        .sort((a, b) => Number(b.online) - Number(a.online) ||
            compareNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const online = devices.filter(device => device.online).length;
    const title = devices.length === 0 ? 'No other devices' : 'Other devices';
    const count = devices.length === 0 ? '' : ` · ${online} of ${devices.length} online`;
    return {caption: title + count, title, count, devices};
}
