/** The switches of the Settings submenu: the `tailscale get --json` key, which is also the flag. */
export const SETTINGS = [
    {id: 'accept-routes', label: 'Use Tailscale subnets'},
    {id: 'accept-dns', label: 'Use Tailscale DNS'},
    {id: 'shields-up', label: 'Block incoming connections'},
];

/**
 * Reads the result of `tailscale get --json`, {missing, timedOut, exitCode, stdout, stderr}.
 * Returns the boolean preferences it printed as an object, or null when the read failed or printed
 * something that is not an object. A key that is missing or not a boolean is simply absent.
 */
export function parsePrefs(result) {
    if (result.missing || result.timedOut || result.exitCode !== 0)
        return null;
    let data;
    try {
        data = JSON.parse(result.stdout);
    } catch {
        return null;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data))
        return null;
    return Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value === 'boolean'));
}

/** The `tailscale set` arguments that give a preference a value. */
export function setArguments(flag, value) {
    return ['set', `--${flag}=${value}`];
}

/**
 * The switch rows of the Settings submenu, `{id, label, value, sensitive}`. `prefs` comes from
 * parsePrefs (null when the read failed) and `pending` is the action in progress, if any.
 * A switch whose value is unknown is insensitive; so is every switch while an action is pending,
 * and the one being set shows the value that was requested.
 */
export function settingRows(prefs, pending) {
    return SETTINGS.map(({id, label}) => {
        const known = typeof prefs?.[id] === 'boolean';
        const requested = pending?.kind === 'set' && pending.flag === id;
        return {
            id,
            label,
            value: requested ? pending.value : known && prefs[id],
            sensitive: known && !pending,
        };
    });
}
