const MAX_PORT = 65535;

/** Compares two strings by code point, which `<` on UTF-16 code units does not. */
export function compareCodePoints(first, second) {
    const a = Array.from(first);
    const b = Array.from(second);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index++) {
        const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
        if (difference !== 0)
            return difference;
    }
    return a.length - b.length;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The members of an object, or none for anything else.
function entriesOf(value) {
    return isObject(value) ? Object.entries(value) : [];
}

function text(value) {
    return typeof value === 'string' ? value : '';
}

/** A port written as a canonical integer from 1 to 65535, as a number, or null. */
export function parsePort(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,4}$/.test(value))
        return null;
    const port = Number(value);
    return port <= MAX_PORT ? port : null;
}

// `<host>:<port>` into its parts, or null when the port is not one.
function splitHostPort(key) {
    const cut = key.lastIndexOf(':');
    if (cut < 0)
        return null;
    const port = parsePort(key.slice(cut + 1));
    return port === null ? null : {host: key.slice(0, cut), port};
}

function pathOf(mount) {
    if (mount === '/')
        return '';
    return mount.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function targetOf(handler) {
    if (text(handler.Proxy) !== '')
        return handler.Proxy;
    if (text(handler.Path) !== '')
        return handler.Path;
    if (text(handler.Text) !== '')
        return 'text';
    if (text(handler.Redirect) !== '')
        return `redirect ${handler.Redirect}`;
    return '';
}

function firstLabel(host) {
    return host.split('.')[0];
}

/** The `tailscale serve` arguments that remove a share. */
export function stopArguments(share) {
    if (share.kind === 'tcp') {
        const flag = share.terminated ? 'tls-terminated-tcp' : 'tcp';
        return ['serve', `--${flag}=${share.port}`, 'off'];
    }
    return ['serve', `--${share.scheme}=${share.port}`, `--set-path=${share.mount}`, 'off'];
}

// The shares of one config: `origin` is {foreground, session}. Hosts are compared as they are
// written: the CLI looks a share up under the exact host key it builds from this device's name.
function sharesOfConfig(config, selfName, origin) {
    const tcp = isObject(config.TCP) ? config.TCP : {};
    const funnel = isObject(config.AllowFunnel) ? config.AllowFunnel : {};
    const shares = [];
    // Hosts that serve a handler, by port, for the rule about a port shared with another host.
    const hostsByPort = new Map();
    const webEntries = [];

    for (const [key, entry] of entriesOf(config.Web)) {
        const parsed = splitHostPort(key);
        if (parsed === null || parsed.host === '')
            continue;
        const forward = tcp[String(parsed.port)];
        if (!isObject(forward) || (forward.HTTPS !== true && forward.HTTP !== true))
            continue;
        const handlers = entriesOf(isObject(entry) ? entry.Handlers : null);
        if (handlers.length > 0) {
            const hosts = hostsByPort.get(parsed.port) ?? new Set();
            hosts.add(parsed.host);
            hostsByPort.set(parsed.port, hosts);
        }
        webEntries.push({key, ...parsed, https: forward.HTTPS === true, handlers});
    }

    for (const entry of webEntries) {
        const scheme = entry.https ? 'https' : 'http';
        const showPort = !(scheme === 'https' && entry.port === 443) &&
            !(scheme === 'http' && entry.port === 80);
        for (const [mount, handlerValue] of entry.handlers) {
            const handler = isObject(handlerValue) ? handlerValue : {};
            let path;
            try {
                path = pathOf(mount);
            } catch {
                // A mount with a lone surrogate cannot be encoded: the entry is ignored.
                continue;
            }
            const port = showPort ? `:${entry.port}` : '';
            const otherHost = [...(hostsByPort.get(entry.port) ?? [])].some(host => host !== entry.host);
            shares.push({
                kind: 'web',
                scheme,
                host: entry.host,
                port: entry.port,
                mount,
                url: `${scheme}://${entry.host}${port}${path}`,
                label: `${scheme}://${firstLabel(entry.host)}${port}${mount === '/' ? '' : mount}`,
                target: targetOf(handler),
                public: funnel[entry.key] === true,
                terminated: false,
                background: !origin.foreground,
                canStop: !origin.foreground && entry.host === selfName && !otherHost,
            });
        }
    }

    if (selfName !== '') {
        for (const [portKey, value] of entriesOf(config.TCP)) {
            const port = parsePort(portKey);
            if (port === null || !isObject(value) || text(value.TCPForward) === '')
                continue;
            const otherHost = [...(hostsByPort.get(port) ?? [])].some(host => host !== selfName);
            shares.push({
                kind: 'tcp',
                scheme: '',
                host: selfName,
                port,
                mount: '',
                url: `${selfName}:${port}`,
                label: `tcp://${firstLabel(selfName)}:${port}`,
                target: value.TCPForward,
                public: funnel[`${selfName}:${port}`] === true,
                terminated: text(value.TerminateTLS) !== '',
                background: !origin.foreground,
                canStop: !origin.foreground && !otherHost,
            });
        }
    }

    return shares
        // A Web and a TCP share on one port and host never meet in a config Tailscale writes: the
        // Web one comes first, whatever the mounts.
        .sort((a, b) => a.port - b.port || compareCodePoints(a.host, b.host) ||
            (a.kind === b.kind ? 0 : a.kind === 'web' ? -1 : 1) || compareCodePoints(a.mount, b.mount))
        .map(share => ({
            ...share,
            key: JSON.stringify([
                origin.foreground ? origin.session : null, share.kind, share.host, share.port, share.mount,
            ]),
            stopArgs: share.canStop ? stopArguments(share) : null,
        }));
}

/**
 * The shares of a parsed serve config, background ones first, then those of each foreground
 * session by session key. `selfName` is this device's MagicDNS name without its trailing dot.
 */
export function sharesOf(config, selfName) {
    if (!isObject(config))
        return [];
    const shares = sharesOfConfig(config, selfName, {foreground: false, session: null});
    const sessions = entriesOf(config.Foreground)
        .filter(([, session]) => isObject(session))
        .sort(([a], [b]) => compareCodePoints(a, b));
    for (const [session, sessionConfig] of sessions)
        shares.push(...sharesOfConfig(sessionConfig, selfName, {foreground: true, session}));
    return shares;
}

/**
 * Reads the result of `tailscale serve status --json`, {missing, timedOut, exitCode, stdout,
 * stderr}. Returns {ok: true, shares} for a good read, with no share for `null` and `{}`, or
 * {ok: false, shares: []} when the command failed or printed JSON that is not an object.
 */
export function readShares(result, selfName) {
    const failed = {ok: false, shares: []};
    if (result.missing || result.timedOut || result.exitCode !== 0)
        return failed;
    let config;
    try {
        config = JSON.parse(result.stdout);
    } catch {
        return failed;
    }
    if (config === null)
        return {ok: true, shares: []};
    if (!isObject(config))
        return failed;
    return {ok: true, shares: sharesOf(config, selfName)};
}

// Which tile a share gets, as a colour name and an icon.
const TILES = {
    public: {color: 'orange', icon: 'web-browser-symbolic'},
    web: {color: 'teal', icon: 'send-to-symbolic'},
    tcp: {color: 'brown', icon: 'network-wired-symbolic'},
    foreground: {color: 'grey', icon: 'utilities-terminal-symbolic'},
};

/** The tile of a share: public first, then foreground, then the kind. */
export function tileOf(share) {
    if (share.public)
        return TILES.public;
    if (!share.background)
        return TILES.foreground;
    return share.kind === 'tcp' ? TILES.tcp : TILES.web;
}

/**
 * The Shared section. `read` is the model's share read, null when none was made. `pending` is the
 * action in progress. Returns {shown, failed, rows}, where a row is {key, label, public, tile,
 * url, line, canStop, stopSensitive, stopName} and `line` the second line.
 */
export function sharedSection(read, pending) {
    if (read === null || read === undefined)
        return {shown: false, failed: false, rows: []};
    if (!read.ok)
        return {shown: true, failed: true, rows: []};
    const rows = read.shares.map(share => {
        const stopping = pending?.kind === 'stop' && pending.key === share.key;
        let line = share.target === '' ? '' : `→ ${share.target}`;
        if (stopping)
            line = 'Stopping…';
        return {
            key: share.key,
            label: share.label,
            public: share.public,
            tile: tileOf(share),
            url: share.url,
            line,
            canStop: share.canStop,
            stopSensitive: share.canStop && !pending,
            stopName: `Stop sharing ${share.url}`,
            stopArgs: share.stopArgs,
        };
    });
    return {shown: rows.length > 0, failed: false, rows};
}
