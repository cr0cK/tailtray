/**
 * Reads the stdout of `tailscale switch --list --json`: an array of
 * `{id, nickname, tailnet, account, selected}`. Returns one profile per object of the array, in
 * order (an empty array is a valid, empty list), or null when the output is not an array. Every
 * field is optional; a profile without an `id` is listed but cannot be switched to.
 */
export function parseProfiles(stdout) {
    let data;
    try {
        data = JSON.parse(stdout);
    } catch {
        return null;
    }
    if (!Array.isArray(data))
        return null;
    const text = value => (typeof value === 'string' ? value : '');
    const profiles = data
        .filter(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
        .map(entry => ({
            id: text(entry.id),
            tailnet: text(entry.tailnet),
            nickname: text(entry.nickname),
            account: text(entry.account),
            selected: entry.selected === true,
        }));
    return profiles;
}

/** What a profile row names: its tailnet, else its nickname, its id, or its account. */
function profileTitle(profile) {
    return profile.tailnet || profile.nickname || profile.id || profile.account;
}

/**
 * The rows of the Account submenu. `accounts` is `{profiles, loading, failed}`: the profiles of
 * the last answer or null, whether a request runs, and whether the last one failed. `pending` is
 * the action in progress, if any. Returns `{message}` for a single insensitive row of text, or
 * `{profiles}` with one `{id, title, account, selected, sensitive, progress}` per profile, in the
 * order of the answer (the list may be empty); a profile without an id is never sensitive.
 *
 * While an action is pending every row is insensitive and the profile being switched to shows
 * `Switching…`. While a request runs, the previous profiles stay, insensitive.
 */
export function accountRows(accounts, pending) {
    if (accounts.failed)
        return {message: 'Could not list accounts'};
    if (!accounts.profiles)
        return {message: 'Loading…'};
    const locked = accounts.loading || Boolean(pending);
    return {
        profiles: accounts.profiles.map(profile => ({
            id: profile.id,
            title: profileTitle(profile),
            account: profile.account,
            selected: profile.selected,
            sensitive: !locked && profile.id !== '',
            progress: pending?.kind === 'switch' && profile.id !== '' && pending.id === profile.id ? 'Switching…' : '',
        })),
    };
}

/**
 * The current tailnet shown on the Account row: the one of the status, else the one of the
 * selected profile, else nothing.
 */
export function currentTailnet(status, profiles) {
    const name = status?.CurrentTailnet?.Name;
    if (typeof name === 'string' && name !== '')
        return name;
    const selected = profiles?.find(profile => profile.selected);
    return selected ? profileTitle(selected) : '';
}
