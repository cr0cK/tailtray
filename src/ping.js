/** The time limit of a ping command: twice the 5 seconds `tailscale ping` itself waits. */
export const PING_TIMEOUT_SECONDS = 10;

const UNITS_MS = {h: 3600000, m: 60000, s: 1000, ms: 1, 'µs': 0.001, us: 0.001, ns: 0.000001};
const DURATION_PART = /(\d+(?:\.\d+)?)(h|ms|m|s|µs|us|ns)/g;
// `pong from <name> (<ip>) via <path> in <latency>`, as cmd/tailscale/cli/ping.go prints it; the
// path is `DERP(<region>)`, `peer-relay(<server>)`, or the peer's endpoint.
const PONG = /^pong from .* \([^)]*\) via (\S+) in ((?:\d+(?:\.\d+)?(?:h|ms|m|s|µs|us|ns))+)\s*$/m;

/** The `tailscale ping` arguments for one reply from an IPv4 address, whatever the path. */
export function pingArguments(address) {
    return ['ping', '-c', '1', '--until-direct=false', '--timeout', '5s', address];
}

// A Go duration such as `26ms` or `1.234s` in milliseconds.
function durationMs(text) {
    let total = 0;
    for (const [, amount, unit] of text.matchAll(DURATION_PART))
        total += Number(amount) * UNITS_MS[unit];
    return total;
}

/**
 * Reads the result of a ping command, {missing, timedOut, exitCode, stdout, stderr}, into the
 * text shown on the Ping row. A pong in the output wins over the exit code, since `ping -c 1`
 * can exit 1 after a pong that came through DERP.
 */
export function pingText(result) {
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const pong = PONG.exec(stdout);
    if (pong) {
        const ms = Math.round(durationMs(pong[2]));
        const path = pong[1];
        const derp = /^DERP\((.*)\)$/.exec(path);
        if (derp)
            return derp[1] === '' ? `relay · ${ms} ms` : `relay ${derp[1]} · ${ms} ms`;
        if (path.startsWith('peer-relay('))
            return `peer relay · ${ms} ms`;
        return `direct · ${ms} ms`;
    }
    if (result.missing)
        return 'error';
    if (result.timedOut || /\btimed out\b/.test(stdout) || /^no reply$/m.test(stderr))
        return 'no answer';
    return 'error';
}

/**
 * The pings of the Other devices rows. A ping is not an action: devices ping at the same time,
 * and a second ping on a device whose ping still runs does nothing. A result stays until reset(),
 * which also kills the pings still running, and a killed ping never shows a result.
 *
 * deps: start(args, timeoutSeconds) -> {result: Promise<{missing, timedOut, exitCode, stdout,
 * stderr}>, kill()}; onChange() is called when a ping starts or ends.
 */
export class Pinger {
    constructor(deps) {
        this._deps = deps;
        this._destroyed = false;
        // device id -> {text, kill}; `kill` is set while the ping runs.
        this._entries = new Map();
    }

    /** The text of a device's Ping row: '' before a ping, `…` while it runs, then its result. */
    text(id) {
        return this._entries.get(id)?.text ?? '';
    }

    ping(id, address) {
        if (this._destroyed || this._entries.get(id)?.kill)
            return false;
        const entry = {text: '…', kill: null};
        this._entries.set(id, entry);
        const handle = this._deps.start(pingArguments(address), PING_TIMEOUT_SECONDS);
        entry.kill = handle.kill;
        handle.result.then(result => {
            // A reset, a forgotten device, or a newer ping made this reply stale.
            if (this._destroyed || this._entries.get(id) !== entry)
                return;
            entry.kill = null;
            entry.text = pingText(result);
            this._deps.onChange();
        });
        this._deps.onChange();
        return true;
    }

    /** Drops one device's ping and result, killing the ping if it runs. */
    forget(id) {
        const entry = this._entries.get(id);
        if (!entry)
            return;
        this._entries.delete(id);
        entry.kill?.();
    }

    /** Drops every ping and result, killing the pings that run. */
    reset() {
        const entries = [...this._entries.values()];
        this._entries.clear();
        for (const entry of entries)
            entry.kill?.();
    }

    destroy() {
        this._destroyed = true;
        this.reset();
    }
}
