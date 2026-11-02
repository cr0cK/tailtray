import {parseTime} from './time.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WINDOW_DAYS = 7;
// The header already says that Tailscale is stopped.
const HIDDEN_HEALTH = 'Tailscale is stopped.';

/**
 * The warning about this device's key, or null when the key does not expire (a missing or zero
 * KeyExpiry) or expires in more than 7 days.
 */
export function keyExpiryWarning(keyExpiry, nowMs) {
    const expiry = parseTime(keyExpiry);
    if (expiry === null)
        return null;
    const remaining = expiry - nowMs;
    if (remaining <= 0)
        return 'This device\'s key has expired.';
    if (remaining > EXPIRY_WINDOW_DAYS * DAY_MS)
        return null;
    if (remaining < DAY_MS)
        return 'This device\'s key expires in less than a day.';
    const days = Math.floor(remaining / DAY_MS);
    return `This device's key expires in ${days} ${days === 1 ? 'day' : 'days'}.`;
}

/** The warnings to show: the key expiry first, then the Health entries in their order. */
export function buildWarnings(status, nowMs) {
    const warnings = [];
    const expiry = keyExpiryWarning(status?.Self?.KeyExpiry, nowMs);
    if (expiry)
        warnings.push(expiry);
    if (Array.isArray(status?.Health)) {
        for (const entry of status.Health) {
            if (typeof entry === 'string' && entry !== '' && entry !== HIDDEN_HEALTH)
                warnings.push(entry);
        }
    }
    return warnings;
}
