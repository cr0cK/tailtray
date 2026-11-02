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
