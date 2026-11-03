import {parseProfiles} from './accounts.js';
import {describeFailure} from './errors.js';
import {parsePrefs} from './settings.js';
import {readStatus, sectionsOf, STATES} from './status.js';

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
 * intervalSeconds() -> number; userName; onChange(model); and optionally
 * onGoodRefresh({state, status, nowMs, lastActionMs}), called for every successful refresh that
 * counts (never for a failed or a discarded one), where `lastActionMs` is when the last action
 * started, or null.
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
        this._lastActionMs = null;
        this._timer = null;
        this._menuOpen = false;
        // Whether the Account section is shown in an open menu, and the request that counts.
        this._accountsActive = false;
        this._accountsSeq = 0;
        this._model = {
            loaded: false,
            state: STATES.connecting,
            status: null,
            // The boolean preferences of `tailscale get --json`, or null when it was not read.
            prefs: null,
            // The profiles of the last `switch --list --json` answer, or null when there was
            // none or it failed.
            accounts: {profiles: null, loading: false, failed: false},
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

    /** The menu opened: the Account section, if shown, lists the profiles once. */
    menuOpened() {
        if (this._destroyed)
            return;
        this._menuOpen = true;
        this._syncAccounts(false);
    }

    /** The menu closed: an error never appears in a later opening. */
    menuClosed() {
        if (this._destroyed)
            return;
        this._menuOpen = false;
        this._accountsActive = false;
        // The pending action's error is dropped too, including one that has not happened yet.
        if (this._pending) {
            this._pending.error = null;
            this._pending.errorDropped = true;
        }
        if (this._model.actionError) {
            this._model.actionError = null;
            this._emit();
        }
    }

    /**
     * Runs one action, a `tailscale` command that changes the state. Returns false when it is
     * refused because another action is pending. `kind` is 'up' or 'down' for the header switch,
     * 'switch' for an account and 'set' for a preference; `detail` (`{id}` or `{flag, value}`)
     * is what the menu shows of its progress.
     */
    runAction(kind, args, detail = {}) {
        if (this._destroyed || this._pending)
            return false;
        this._generation++;
        this._lastActionMs = this._deps.now();
        this._pending = {kind, error: null, errorDropped: false};
        this._model.actionError = null;
        this._model.pending = {kind, ...detail};
        this._emit();
        this._deps.run(args, COMMAND_TIMEOUT_SECONDS).then(result => {
            if (this._destroyed)
                return;
            this._generation++;
            if (!succeeded(result) && !this._pending.errorDropped)
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
        const read = readStatus(await this._deps.run(['status', '--json'], COMMAND_TIMEOUT_SECONDS));
        if (this._destroyed)
            return;
        // While an action is pending only its follow-up counts, and a refresh that started
        // before the last step of an action never shows the state from before it.
        const counts = () => generation === this._generation && (this._pending === null || followUp);
        // The preferences are read after the status, only when the state has Settings to show,
        // and not at all when the refresh is already known to be discarded.
        let prefs = null;
        if (read.ok && counts() && sectionsOf(read.state).settings) {
            prefs = parsePrefs(await this._deps.run(['get', '--json'], COMMAND_TIMEOUT_SECONDS));
            if (this._destroyed)
                return;
        }
        this._refreshing = false;

        if (counts())
            this._apply(read, prefs, followUp);

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

    _apply(read, prefs, followUp) {
        const model = this._model;
        const switched = followUp && this._pending?.kind === 'switch';
        if (read.ok) {
            model.loaded = true;
            model.state = read.state;
            model.status = read.status;
            model.prefs = prefs;
            model.refreshError = null;
            model.updatedAt = this._deps.now();
        } else {
            model.loaded = true;
            model.state = STATES.unavailable;
            model.status = null;
            model.prefs = null;
            model.refreshError = describeFailure(read.failure, this._deps.userName);
        }
        if (followUp)
            this._finishAction(read.ok);
        // Listing the profiles again after a switch is the only thing besides the menu opening
        // that does.
        this._syncAccounts(switched);
        this._emit();
        if (read.ok) {
            this._deps.onGoodRefresh?.({
                state: read.state,
                status: read.status,
                nowMs: model.updatedAt,
                lastActionMs: this._lastActionMs,
            });
        }
    }

    // Lists the profiles when the Account section appears in an open menu, and after a switch
    // while the section is shown; never on another refresh, and never while the section is hidden.
    _syncAccounts(reload) {
        const visible = this._model.loaded && sectionsOf(this._model.state).account;
        const active = this._menuOpen && visible;
        const appeared = active && !this._accountsActive;
        this._accountsActive = active;
        if (visible && (appeared || reload))
            this._requestAccounts();
    }

    _requestAccounts() {
        const seq = ++this._accountsSeq;
        const accounts = this._model.accounts;
        accounts.loading = true;
        accounts.failed = false;
        this._emit();
        this._deps.run(['switch', '--list', '--json'], COMMAND_TIMEOUT_SECONDS).then(result => {
            // A newer request, or a disable, makes this reply stale.
            if (this._destroyed || seq !== this._accountsSeq)
                return;
            const profiles = succeeded(result) ? parseProfiles(result.stdout) : null;
            accounts.loading = false;
            accounts.profiles = profiles;
            accounts.failed = profiles === null;
            this._emit();
        });
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
