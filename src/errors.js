export const INSTALL_URL = 'https://tailscale.com/download/linux';
export const ADMIN_CONSOLE_URL = 'https://login.tailscale.com/admin/machines';

/**
 * Explains a failed command. A failure is {missing, timedOut, unreadable, exitCode, stdout,
 * stderr}: missing when the CLI is not on PATH, unreadable when a status exited 0 with output
 * Tailtray cannot read. Returns {text, command, link}: a command to copy and a link to open, or
 * null for each. The checks run in the order of the spec's error table.
 */
export function describeFailure(failure, userName) {
    const output = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`;
    if (failure.missing) {
        return {
            text: 'The Tailscale CLI is not installed.',
            command: null,
            link: {label: 'Install Tailscale', url: INSTALL_URL},
        };
    }
    if (output.includes('failed to connect to local tailscaled') || output.includes('is Tailscale running?')) {
        return {
            text: 'The Tailscale service is not running.',
            command: 'sudo systemctl enable --now tailscaled',
            link: null,
        };
    }
    if (output.includes('Access denied') || output.includes('access denied')) {
        return {
            text: 'Tailtray needs you to be the Tailscale operator.',
            command: `sudo tailscale set --operator=${userName}`,
            link: null,
        };
    }
    if (failure.timedOut)
        return {text: 'The command timed out.', command: null, link: null};
    if (failure.unreadable)
        return {text: 'Tailscale returned a status Tailtray cannot read.', command: null, link: null};
    const line = (failure.stderr ?? '').split('\n').map(text => text.trim()).find(text => text !== '');
    return {text: line ?? 'The command failed.', command: null, link: null};
}
