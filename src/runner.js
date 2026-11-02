import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const OVERRIDE_VARIABLE = 'TAILTRAY_TIMEOUT_SECONDS';
const COMMAND = 'tailscale';

/**
 * Runs `tailscale` commands without a shell, each with its own time limit, and kills every one
 * still running on destroy(). The command is found on PATH once, when the runner is created, which
 * is when the extension is enabled. run() never rejects: its result is {missing, timedOut,
 * exitCode, stdout, stderr}, where missing means `tailscale` was not on PATH and timedOut that
 * the time limit killed the process.
 *
 * The environment variable TAILTRAY_TIMEOUT_SECONDS replaces every time limit; the headless
 * tests lower it to see a sleeping command killed.
 */
export class CommandRunner {
    constructor() {
        this._processes = new Map();
        this._cancellable = new Gio.Cancellable();
        this._executable = GLib.find_program_in_path(COMMAND);
        const override = Number(GLib.getenv(OVERRIDE_VARIABLE));
        this._override = Number.isFinite(override) && override > 0 ? override : null;
    }

    run(args, timeoutSeconds) {
        const result = {missing: false, timedOut: false, exitCode: -1, stdout: '', stderr: ''};
        if (this._cancellable.is_cancelled())
            return Promise.resolve(result);
        if (this._executable === null) {
            result.missing = true;
            return Promise.resolve(result);
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        let process;
        try {
            process = launcher.spawnv([this._executable, ...args]);
        } catch (error) {
            // The file went away since the extension was enabled.
            result.missing = error.matches(GLib.SpawnError, GLib.SpawnError.NOENT);
            result.stderr = error.message;
            return Promise.resolve(result);
        }

        const entry = {timeoutId: 0};
        this._processes.set(process, entry);
        const limitMs = Math.round((this._override ?? timeoutSeconds) * 1000);
        entry.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, limitMs, () => {
            entry.timeoutId = 0;
            result.timedOut = true;
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        return new Promise(resolve => {
            process.communicate_utf8_async(null, this._cancellable, (subprocess, asyncResult) => {
                this._processes.delete(subprocess);
                if (entry.timeoutId) {
                    GLib.Source.remove(entry.timeoutId);
                    entry.timeoutId = 0;
                }
                try {
                    const [, stdout, stderr] = subprocess.communicate_utf8_finish(asyncResult);
                    result.stdout = stdout ?? '';
                    result.stderr = stderr ?? '';
                    result.exitCode = subprocess.get_if_exited() ? subprocess.get_exit_status() : -1;
                } catch (error) {
                    result.stderr = error.message;
                }
                resolve(result);
            });
        });
    }

    /** Kills every running command; their results are still delivered, and callers ignore them. */
    destroy() {
        this._cancellable.cancel();
        for (const [process, entry] of this._processes) {
            if (entry.timeoutId)
                GLib.Source.remove(entry.timeoutId);
            entry.timeoutId = 0;
            process.force_exit();
        }
        this._processes.clear();
    }
}
