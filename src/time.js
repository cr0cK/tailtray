const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_DAYS = 30;

/**
 * Reads a timestamp of `tailscale status --json`. Go prints its zero time as
 * 0001-01-01T00:00:00Z, which means "never": it and anything unreadable give null.
 */
export function parseTime(value) {
    if (typeof value !== 'string' || value === '')
        return null;
    const ms = Date.parse(value);
    if (Number.isNaN(ms) || new Date(ms).getUTCFullYear() <= 1)
        return null;
    return ms;
}

/** How long ago a timestamp was, or an empty string when it is missing or the zero time. */
export function relativeTime(value, nowMs) {
    const ms = parseTime(value);
    if (ms === null)
        return '';
    const elapsed = nowMs - ms;
    if (elapsed < MINUTE_MS)
        return 'just now';
    if (elapsed < HOUR_MS)
        return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
    if (elapsed < DAY_MS)
        return `${Math.floor(elapsed / HOUR_MS)} h ago`;
    const days = Math.floor(elapsed / DAY_MS);
    if (days < MONTH_DAYS)
        return days === 1 ? '1 day ago' : `${days} days ago`;
    const months = Math.floor(days / MONTH_DAYS);
    return months === 1 ? '1 month ago' : `${months} months ago`;
}
