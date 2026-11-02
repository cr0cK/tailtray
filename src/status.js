export const STATES = {
    connected: {id: 'connected', label: 'Connected'},
    connecting: {id: 'connecting', label: 'Connecting…'},
    disconnected: {id: 'disconnected', label: 'Disconnected'},
    login: {id: 'login', label: 'Login required'},
    approval: {id: 'approval', label: 'Waiting for approval'},
    unavailable: {id: 'unavailable', label: 'Unavailable'},
};

const BACKEND_STATES = {
    Running: STATES.connected,
    Starting: STATES.connecting,
    NoState: STATES.connecting,
    Stopped: STATES.disconnected,
    NeedsLogin: STATES.login,
    NeedsMachineAuth: STATES.approval,
};

/** The connection state of a BackendState, or null for a value Tailtray does not know. */
export function stateOfBackend(backendState) {
    return Object.hasOwn(BACKEND_STATES, backendState) ? BACKEND_STATES[backendState] : null;
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Reads the result of `tailscale status --json`, {missing, timedOut, exitCode, stdout, stderr}.
 * Returns {ok: true, status, state} or {ok: false, failure}. The output is parsed before the
 * exit code is looked at, since the command exits 0 in Stopped and NeedsLogin but a daemon that
 * is down exits 1 with nothing on stdout.
 */
export function readStatus(result) {
    if (result.missing || result.timedOut)
        return {ok: false, failure: result};
    const status = parseJson(result.stdout);
    const isObject = status !== null && typeof status === 'object' && !Array.isArray(status);
    if (isObject) {
        const state = stateOfBackend(status.BackendState);
        if (state)
            return {ok: true, status, state};
    }
    if (!isObject && result.exitCode !== 0)
        return {ok: false, failure: result};
    return {ok: false, failure: {...result, unreadable: true}};
}

/** `<tailnet> · <login name>`, leaving out a missing part, or an empty string with neither. */
export function identityLine(status) {
    const tailnet = status?.CurrentTailnet?.Name;
    const userId = status?.Self?.UserID;
    const login = userId === undefined ? undefined : status?.User?.[String(userId)]?.LoginName;
    return [tailnet, login].filter(part => typeof part === 'string' && part !== '').join(' · ');
}

/**
 * The header row for a state. A pending `tailscale up` or `down` replaces the label, and while
 * an action is pending, or before the first answer, the switch cannot be used. `switchOn` is
 * null when the state has no switch. `labelColor` is 'warning', 'error', or null.
 */
export function headerModel(state, pending, loaded) {
    let label = state.label;
    if (pending?.kind === 'up')
        label = 'Connecting…';
    else if (pending?.kind === 'down')
        label = 'Disconnecting…';
    let switchOn = null;
    if (state.id === 'connected' || state.id === 'connecting')
        switchOn = true;
    else if (state.id === 'disconnected')
        switchOn = false;
    if (pending?.kind === 'up')
        switchOn = true;
    else if (pending?.kind === 'down')
        switchOn = false;
    let labelColor = null;
    if (state.id === 'login' || state.id === 'approval')
        labelColor = 'warning';
    else if (state.id === 'unavailable')
        labelColor = 'error';
    return {
        title: 'Tailscale',
        label,
        labelColor,
        switchOn,
        switchSensitive: switchOn !== null && !pending && loaded,
    };
}

/**
 * The panel icon for a state: which glyph, whether it is dimmed, its badge colour, and its
 * accessible name, which carries the header label (`label`, the state's own unless an action
 * is pending).
 */
export function panelIconModel(state, label = state.label) {
    const name = `Tailscale: ${label}`;
    switch (state.id) {
    case 'connected':
        return {glyph: 'filled', dimmed: false, badge: null, name};
    case 'login':
    case 'approval':
        return {glyph: 'outline', dimmed: false, badge: 'warning', name};
    case 'unavailable':
        return {glyph: 'outline', dimmed: true, badge: 'error', name};
    default:
        return {glyph: 'outline', dimmed: true, badge: null, name};
    }
}

/** Which sections of the menu a state shows; the header and the footer always show. */
export function sectionsOf(state) {
    const id = state.id;
    const working = id === 'connected' || id === 'connecting' || id === 'disconnected';
    return {
        identity: working,
        errorBlock: working || id === 'unavailable',
        warnings: id !== 'unavailable',
        thisDevice: id === 'connected',
        account: working,
        settings: id === 'connected' || id === 'disconnected',
        loginHelp: id === 'login',
        approvalHelp: id === 'approval',
    };
}

/**
 * Which separators of the menu show. `device` and `controls` tell whether This device and the
 * Account and Settings group have anything to show. The header group always shows, so a separator
 * follows it when a group does, one sits between the two groups, and one precedes the footer.
 * Two separators never touch, since a group sits between any two.
 */
export function separatorsOf({device, controls}) {
    return {top: device || controls, device: device && controls, footer: true};
}
