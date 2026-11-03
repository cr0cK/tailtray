import {compareNames, deviceName, firstAddress, peerId, peersOf} from './devices.js';

/** The peer in use as exit node, `{id, name}`, or null: the first peer whose `ExitNode` is true. */
export function exitNodeInUse(status) {
    const found = peersOf(status).find(([, peer]) => peer.ExitNode === true);
    return found ? {id: peerId(...found), name: deviceName(found[1])} : null;
}

/**
 * The Exit node submenu. Returns `{summary, available, none, nodes}`:
 * - `summary` is the text on the right of the submenu row: the name of the exit node in use,
 *   `None`, or `None available` (then `available` is false and the row is insensitive);
 * - `none` is `{checked, sensitive, progress}`;
 * - `nodes` has one `{id, name, address, online, checked, sensitive, progress}` per peer whose
 *   `ExitNodeOption` or `ExitNode` is true, sorted by name. `address` is the first IPv4 address,
 *   else the first IPv6 one, else ''.
 *
 * `pending` is the action in progress, if any. While one is pending every row is insensitive and
 * the target of a `set --exit-node` (`pending.target`, a peer id, '' for None) shows `Setting…`.
 * An offline peer is insensitive unless it is the one in use; a peer with no address always is.
 */
export function exitNodeRows(status, pending) {
    const inUse = exitNodeInUse(status);
    const setting = pending?.kind === 'exit';
    const nodes = peersOf(status)
        .filter(([, peer]) => peer.ExitNodeOption === true || peer.ExitNode === true)
        .map(([key, peer]) => {
            const id = peerId(key, peer);
            const address = firstAddress(peer.TailscaleIPs, 4) ?? firstAddress(peer.TailscaleIPs, 6) ?? '';
            const checked = id === inUse?.id;
            const online = peer.Online === true;
            return {
                id,
                name: deviceName(peer),
                address,
                online,
                checked,
                sensitive: !pending && address !== '' && (online || checked),
                progress: setting && pending.target === id ? 'Setting…' : '',
            };
        })
        .sort((a, b) => compareNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const available = nodes.length > 0 || inUse !== null;
    return {
        summary: inUse ? inUse.name : available ? 'None' : 'None available',
        available,
        none: {
            checked: inUse === null,
            sensitive: !pending,
            progress: setting && pending.target === '' ? 'Setting…' : '',
        },
        nodes,
    };
}

/** The `tailscale set` arguments that choose an exit node by address, or none with ''. */
export function exitNodeArguments(address) {
    return ['set', `--exit-node=${address}`];
}
