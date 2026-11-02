import {describeFailure} from './errors.js';
import {readStatus, STATES} from './status.js';

export const COMMAND_TIMEOUT_SECONDS = 30;

function succeeded(result) {
    return !result.missing && !result.timedOut && result.exitCode === 0;
}

/**
 * Reads the Tailscale state and runs the actions that change it. It owns the rules of "Reading
 * the state" and "Actions" and nothing of GNOME Shell: the commands, the timer, and the clock
 * come in through `deps`, so node tests drive it.
 *
 * deps: run(args, timeoutSeconds) -> Promise<{missing, timedOut, exitCode, stdout, stderr}>;
 * setTimer(milliseconds, callback) -> handle; clearTimer(handle); now() -> milliseconds;
 * intervalSeconds() -> number; userName; onChange(model).
 *
 * An engine lives for one enable. destroy() makes every pending completion a no-op, so a reply
 * that arrives after a disable, even after a re-enable, touches nothing.
 */
export class Engine {
    constructor(deps) {
        this._deps = deps;
        this._destroyed = false;
        this._refreshing = false;
        // What waits for the running refresh: null, 'normal', or 'followUp'.
        this._queued = null;
        // Bumped when an action starts, when its command ends, and when it ends, so a refresh that
        // started before any of those no longer matches and is discarded.
        this._generation = 0;
        this._pending = null;
        this._timer = null;
        this._model = {
            loaded: false,
            state: STATES.connecting,
            status: null,
            refreshError: null,
            actionError: null,
            pending: null,
            updatedAt: null,
        };
    }

    get model() {
        return this._model;
    }

    /** Starts the first refresh. */
    start() {
        this.requestRefresh();
    }

    destroy() {
        this._destroyed = true;
        this._clearTimer();
        this._queued = null;
        this._pending = null;
    }

    /** Asks for a refresh: runs now, queues once behind the running one, or is dropped. */
    requestRefresh() {
        this._request(false);
    }

    /** The menu closed: an error never appears in a later opening. */
    menuClosed() {
        if (this._destroyed)
            return;
        if (this._pending)
            this._pending.error = null;
        if (this._model.actionError) {
            this._model.actionError = null;
            this._emit();
        }
    }

    /**
     * Runs one action, a `tailscale` command that changes the state. Returns false when it is
     * refused because another action is pending. `kind` is 'up' or 'down' for the header switch.
     */
    runAction(kind, args) {
        if (this._destroyed || this._pending)
            return false;
        this._generation++;
        this._pending = {kind, error: null};
        this._model.actionError = null;
        this._model.pending = {kind};
        this._emit();
        this._deps.run(args, COMMAND_TIMEOUT_SECONDS).then(result => {
            if (this._destroyed)
                return;
            this._generation++;
            if (!succeeded(result))
                this._pending.error = describeFailure(result, this._deps.userName);
            this._request(true);
        });
        return true;
    }

    _request(followUp) {
        if (this._destroyed)
            return;
        if (this._refreshing) {
            if (followUp)
                this._queued = 'followUp';
            else if (!this._queued)
                this._queued = 'normal';
            return;
        }
        this._refresh(followUp);
    }

    async _refresh(followUp) {
        this._refreshing = true;
        this._clearTimer();
        const generation = this._generation;
        const result = await this._deps.run(['status', '--json'], COMMAND_TIMEOUT_SECONDS);
        if (this._destroyed)
            return;
        this._refreshing = false;

        // While an action is pending only its follow-up counts, and a refresh that started
        // before the last step of an action never shows the state from before it.
        const counts = generation === this._generation && (this._pending === null || followUp);
        if (counts)
            this._apply(readStatus(result), followUp);

        const queued = this._queued;
        this._queued = null;
        if (queued) {
            this._refresh(queued === 'followUp');
            return;
        }
        this._timer = this._deps.setTimer(this._deps.intervalSeconds() * 1000, () => {
            this._timer = null;
            this.requestRefresh();
        });
    }

    _apply(read, followUp) {
        const model = this._model;
        if (read.ok) {
            model.loaded = true;
            model.state = read.state;
            model.status = read.status;
            model.refreshError = null;
            model.updatedAt = this._deps.now();
        } else {
            model.loaded = true;
            model.state = STATES.unavailable;
            model.status = null;
            model.refreshError = describeFailure(read.failure, this._deps.userName);
        }
        if (followUp)
            this._finishAction(read.ok);
        this._emit();
    }

    // The error of a failed action is decided here, once its follow-up answered: the menu shows
    // Login required or Approval required, or the Unavailable error, instead when they apply.
    _finishAction(followUpSucceeded) {
        const {error} = this._pending;
        this._pending = null;
        this._generation++;
        this._model.pending = null;
        const state = this._model.state.id;
        if (error && followUpSucceeded && state !== 'login' && state !== 'approval')
            this._model.actionError = error;
    }

    _clearTimer() {
        if (this._timer !== null) {
            this._deps.clearTimer(this._timer);
            this._timer = null;
        }
    }

    _emit() {
        this._deps.onChange(this._model);
    }
}
