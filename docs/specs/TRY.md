---
code: TRY
status: draft
version: v0.1
tracking: "#1"
---

# Tailtray — TRY specification

TRY covers the first release of Tailtray, a GNOME Shell 49 extension that shows and controls the
local Tailscale node from the top bar by calling the `tailscale` CLI. It covers the panel icon,
connecting and disconnecting, the identity and addresses of this device, switching between
accounts that are already logged in, choosing an exit node, three Tailscale settings, the list of
the other devices of the tailnet with copy and ping actions, desktop notifications, and the
preferences window.

The mockup, [`mockups/TRY.html`](mockups/TRY.html), shows every state of the menu, the
notifications, and the preferences window; open it in a browser. Where it and the rules disagree,
the rules win.

## Audience and environment

- Personal use on GNOME Shell 49, on Linux.
- The `tailscale` CLI and the `tailscaled` service must be installed, version 1.104 or later.
  Tailtray finds `tailscale` on `PATH` when the extension is enabled. With an older version, a
  command that does not exist fails and shows its error as Errors describes; Tailtray does not
  check the version.
- Actions that change Tailscale (connect, disconnect, switch, set) need the user to be the
  Tailscale operator (`tailscale set --operator=$USER`, run once with sudo). Reading the state
  does not.
- Tailtray talks to the default `tailscaled` socket only.
- The extension is named Tailtray, its UUID is `tailtray@cr0ck.github.io`, and its settings live
  under `org.gnome.shell.extensions.tailtray`. All UI text is in English.

## Reading the state

- Each refresh runs `tailscale status --json`, then, when it succeeded and the backend is
  `Running` or `Stopped`, `tailscale get --json`. The two calls run one after the other.
- Only one refresh runs at a time. A refresh requested while one runs is queued once; further
  requests while one is queued are dropped.
- A refresh runs:
  - when the extension is enabled;
  - every refresh interval (see Preferences), counted from the end of the previous refresh;
  - when the menu opens;
  - right after every action Tailtray runs, whether it succeeded or failed;
  - when **Refresh now** is activated.
- A refresh succeeds when `tailscale status --json` succeeds. When only `tailscale get --json`
  fails, the refresh still succeeds: the switches that need its values are insensitive (see
  Settings and Exit node), and nothing else changes.
- A failed refresh keeps the last good state in memory for notifications, but the menu and the
  icon show the failure (see Unavailable).
- While an action is pending (see Actions), only its follow-up refresh counts: the result of any
  other refresh, already running or started meanwhile, is discarded. A refresh that started
  before the last action ended is discarded too. So a refresh never shows the state from before
  an action, and never mixes two accounts.
- A refresh while the menu is open updates the menu in place: the expanded submenu, the expanded
  device, and each device's last ping result stay as they are, as long as that submenu or device
  still exists.
- Updating a switch from a refresh never runs a command. Only a user's toggle does.

## Connection states

Tailtray derives one state from `BackendState` of `tailscale status --json`:

| State | When | Header label |
|---|---|---|
| Connected | `Running` | `Connected` |
| Connecting | `Starting` or `NoState` | `Connecting…` |
| Disconnected | `Stopped` | `Disconnected` |
| Login required | `NeedsLogin` | `Login required` |
| Approval required | `NeedsMachineAuth` | `Waiting for approval` |
| Unavailable | The CLI is missing, the call fails, times out, or prints JSON Tailtray cannot read, or `BackendState` has any other value | `Unavailable` |

## Panel icon

- The panel shows one symbolic icon and no text. The icon is Tailtray's own glyph, not the
  Tailscale logo.
- Connected: the full glyph.
- Connected through an exit node: the full glyph with an arrow badge.
- Connecting and Disconnected: the glyph outlined and dimmed.
- Login required and Approval required: the outlined glyph with a yellow dot badge.
- Unavailable: the dimmed glyph with a red dot badge.
- The icon's accessible name is `Tailscale: <header label>`.

## Menu layout

The menu shows these sections, top to bottom. A section that a state does not list is hidden.

| Section | Connected | Connecting | Disconnected | Login / Approval required | Unavailable |
|---|---|---|---|---|---|
| Header | yes | yes | yes | yes | yes |
| Identity line | yes | yes | yes | no | no |
| Error block | when set | when set | when set | no | yes |
| Warnings | when any | when any | when any | when any | no |
| This device | yes | no | no | no | no |
| Account | yes | yes | yes | no | no |
| Exit node | yes | no | no | no | no |
| Settings | yes | no | yes | no | no |
| Other devices | yes | no | no | no | no |
| Footer | yes | yes | yes | yes | yes |

Separators sit between groups as in the mockup: after the warnings, after This device, after
Settings, and before the footer. Two separators never touch.

### Header

- A row with the title `Tailscale`, the header label, and a switch.
- The switch shows on in Connected and Connecting, off in Disconnected, and is absent in the other
  states. In Login required, Approval required, and Unavailable the header label is colored:
  yellow for the first two, red for Unavailable.
- Turning the switch on runs `tailscale up` with no argument. Turning it off runs
  `tailscale down`. Activating the row toggles the switch. The menu stays open.
- While either command runs, the switch is insensitive and the label reads `Connecting…` or
  `Disconnecting…`. The next refresh sets the real state.
- `tailscale up` is never run with flags: with any flag, it would rewrite preferences.
- `tailscale up` waits for authentication when the node needs a login or an approval, so it can
  end by its time limit. Actions handle that case as Actions says.

### Identity line

- One dim line: `<tailnet> · <login name>`, where the tailnet is `CurrentTailnet.Name` and the
  login name is `User[Self.UserID].LoginName`.
- A missing part is left out with its separator. With both missing, the line is hidden.

### Login required and Approval required

- In these two states Tailtray is blocked: logging in or getting approved happens outside it, and
  the menu offers nothing else than what follows, plus the warnings and the footer.
- Login required shows, under the header, the line `Log in from a terminal:` and the command
  `tailscale up` on a row with a copy icon, as in the error block. `AuthURL` is not used.
- Tailtray never runs `tailscale login`: it would start a new, empty profile instead of logging
  the current one back in.
- Approval required shows the line `An admin must approve this device.` and an **Open admin
  console** row that opens `https://login.tailscale.com/admin/machines`.

### Error block

- An action that fails sets the error block: a few lines of text under the header, built as in
  Errors. It stays until the menu closes or the next action starts.
- In Unavailable, the error block explains the failure of the last refresh, and stays until a
  refresh succeeds.
- A command shown in the error block, such as the operator command, sits on its own row with a
  copy icon; activating the row copies the command.

### Warnings

- Warnings come from `Health` of the status, in its order, after removing the entry
  `Tailscale is stopped.` (the header already says it).
- When this device's `Self.KeyExpiry` is within 7 days, a first warning reads
  `This device's key expires in <n> days.` (`in less than a day` under 24 hours, and
  `This device's key has expired.` once past). A missing or zero `KeyExpiry` means the key does
  not expire.
- One warning shows as a yellow line under the identity line. Two or more show as a collapsed
  **Warnings (<n>)** submenu, one line each.
- Each warning line wraps; it is not truncated.

### This device

- A dim caption `This device`, then three rows: the MagicDNS name (`Self.DNSName` without its
  trailing dot), the first IPv4 address, and the first IPv6 address of `Self.TailscaleIPs`.
- Each row ends with a copy icon. Activating a row copies its value (see Copying).
- A missing value hides its row. With no value at all, the caption is hidden too.

### Account

- A submenu row **Account** with the current tailnet on its right, followed by one row per
  profile of `tailscale switch --list --json`.
- `tailscale switch --list --json` runs whenever the Account section appears in an open menu (when
  the menu opens, or when a refresh shows the section while the menu is open) and after every
  account switch; never on other refreshes, and never while the section is hidden.
- Until it answers, the submenu shows the profiles of the last answer, insensitive, or a single
  insensitive `Loading…` row when there was none. When it fails, the submenu shows a single
  insensitive `Could not list accounts` row.
- Each profile row shows the tailnet, and the account under it in dim text. The profile whose
  `selected` is true has a check mark.
- Activating another profile runs `tailscale switch <id>`. Activating the selected profile does
  nothing.
- Logging in to a new account, logging out, and removing an account are not offered.

### Exit node

- A submenu row **Exit node** with the exit node in use on its right, or `None`.
- Its rows are **None**, then every peer whose `ExitNodeOption` or `ExitNode` is true, sorted by
  name (see Device names), then an **Allow LAN access** switch.
- Each exit node row shows a dot, green when the peer is online, grey when not. An offline peer's
  row is insensitive and shows an `offline` badge, unless it is the exit node in use.
- The exit node in use is the peer whose `ExitNode` is true. Its row has a check mark, even when
  the peer is no longer an exit node option. With none, **None** has the check mark.
- Activating an exit node runs `tailscale set --exit-node=<address>`, where the address is its
  first IPv4 address, or its first IPv6 address when it has no IPv4 one. A peer with neither has
  an insensitive row. Activating **None** runs `tailscale set --exit-node=`. Activating the row
  already checked does nothing.
- **Allow LAN access** shows `exit-node-allow-lan-access` of `tailscale get --json`, and toggling
  it runs `tailscale set --exit-node-allow-lan-access=<true|false>`. The switch is shown even with
  no exit node in use; the setting applies once one is chosen. It is insensitive when
  `tailscale get --json` failed or lacks the value.
- With no exit node in use and no peer to list, the submenu row is insensitive and reads
  `None available`.
- The Exit node submenu is at most 280 pixels high, and its rows scroll within it.
- When the exit node in use goes offline, its row keeps the check mark and shows the `offline`
  badge, and the panel keeps the exit node icon.

### Settings

- A submenu row **Settings** with three switches. Each shows a value of `tailscale get --json`
  and toggling it runs `tailscale set` with that flag:

| Row | Value | Command |
|---|---|---|
| Use Tailscale subnets | `accept-routes` | `tailscale set --accept-routes=<true\|false>` |
| Use Tailscale DNS | `accept-dns` | `tailscale set --accept-dns=<true\|false>` |
| Block incoming connections | `shields-up` | `tailscale set --shields-up=<true\|false>` |

- When `tailscale get --json` failed or lacks a value, that switch is insensitive.
- Toggling a switch keeps the menu open.

### Other devices

- A dim caption `Other devices · <online> of <total> online`, counting the listed devices.
- One row per peer of `Peer` in the status, except peers that have a `Location` field (Mullvad
  exit nodes, which appear only under Exit node).
- Order: online peers first, then offline ones, each group sorted by name (see Device names).
- A row shows a dot (green online, grey offline), the name, and on its right the peer's `OS`
  when online, or how long ago it was last seen when offline (see Relative times). Offline names
  are dimmed.
- With no peer to list, the caption reads `No other devices` and there is no row.
- The rows sit in a scrolling area at most 280 pixels high.
- Each row expands in place, like a submenu; expanding one collapses the one that was open. The
  expanded part shows:
  - the MagicDNS name, the first IPv4 address, and the first IPv6 address, each with a copy icon,
    hidden when missing, exactly as in This device;
  - a **Ping** row.
- **Ping** is insensitive when the peer is offline or has no IPv4 address. Activating it runs
  `tailscale ping -c 1 --until-direct=false --timeout 5s <first IPv4 address>`, keeps the menu
  open, and shows on the row's right:
  - `…` while it runs;
  - `direct · <ms> ms` for a pong through a direct path;
  - `relay <region> · <ms> ms` for a pong through DERP;
  - `peer relay · <ms> ms` for a pong through a peer relay;
  - `no answer` when the command times out or reports no pong;
  - `error` for anything else.
- A pong found in the output wins over the exit code. The milliseconds are the pong's latency,
  rounded to the integer.
- A ping result stays on the row until the menu closes. Closing the menu kills every ping still
  running, and its result is never shown.
- Pings are not actions: they run while an action runs, and one device's ping does not block
  another's. A second **Ping** on a device whose ping still runs does nothing.

### Footer

- **Refresh now**, with `updated <relative time>` on its right after the first refresh that
  succeeded. Activating it refreshes and keeps the menu open.
- **Preferences** opens the preferences window.

## Device names

- A device's name is the first label of its `DNSName`. When `DNSName` is empty, it is its
  `HostName`.
- Sorting compares names case-insensitively.

## Relative times

- Under one minute: `just now`. Under one hour: `<n> min ago`. Under one day: `<n> h ago`. Under
  30 days: `<n> days ago` (`1 day ago` for one). Then `<n> months ago` (`1 month ago`), counting
  30 days per month.
- A `LastSeen` that is missing or the zero time shows nothing.

## Copying

- Copying puts the value in the clipboard (the regular clipboard, not the primary selection),
  closes the menu, and shows the Shell's on-screen display on the current monitor, with the
  `edit-copy-symbolic` icon and `Copied <value>`.
- Copying is not an action: it runs no command.

## Actions

- An action is a command that changes Tailscale: the header switch, an account switch, an exit
  node, **Allow LAN access**, and the Settings switches.
- Every action runs one `tailscale` command, with an argument array and no shell.
- One action runs at a time. Its **follow-up** is the refresh Tailtray requests as soon as the
  command ends, whether it succeeded or failed. It takes the place of any refresh already queued,
  and starts as soon as no refresh runs. The action is pending from its start until its
  follow-up answers or fails.
- While it is pending, the row that started it is insensitive and shows its progress, and every
  other action row is insensitive too. Only the follow-up's result is shown (see Reading the
  state), so nothing overwrites that progress.
- The progress shown: the header label reads `Connecting…` or `Disconnecting…`; the account row
  chosen shows `Switching…` on its right; the exit node row chosen, or **None**, shows `Setting…`
  on its right; a switch row (Settings, **Allow LAN access**) shows the requested value at once.
- The follow-up shows the state it reads: a switch shows the value
  `tailscale get --json` returns, which may be the requested one even when the command failed,
  since a killed `tailscale set` is not rolled back. When that read fails, the switch is
  insensitive, as Settings says.
- A failed action's error is decided once its follow-up answers, never before: when the
  follow-up shows Login required or Approval required, the action sets no error block, since the
  menu shows that state; when the follow-up fails, the Unavailable error applies; otherwise the
  action's error fills the error block. This holds for every action, such as `tailscale up` or a
  `tailscale switch` to a logged-out profile.
- Closing the menu drops the error of a pending action as well as the error shown: an error never
  appears in a later opening.
- Actions keep the menu open.

## Commands and time limits

- Every `tailscale` command Tailtray starts is killed when its time limit passes: 10 seconds for
  `tailscale ping`, 30 seconds for every other command, reads included.
- A killed read is a failed read; a killed action fails with `The command timed out.`

## Errors

The error text depends on the failure, checked in this order:

| Failure | Text |
|---|---|
| `tailscale` is not on `PATH` | `The Tailscale CLI is not installed.` and a row **Install Tailscale** that opens `https://tailscale.com/download/linux` |
| The output mentions `failed to connect to local tailscaled` or `is Tailscale running?` | `The Tailscale service is not running.` and the command `sudo systemctl enable --now tailscaled` |
| The output mentions `Access denied` or `access denied` | `Tailtray needs you to be the Tailscale operator.` and the command `sudo tailscale set --operator=<user name>` |
| A timeout | `The command timed out.` |
| A status Tailtray cannot read | `Tailscale returned a status Tailtray cannot read.` |
| Anything else | The first non-empty line of the command's standard error, or `The command failed.` when it is empty |

- The user name is the login name of the user running GNOME Shell.

## Notifications

- Notifications go through one Tailtray notification source. They are sent only when the
  **Notifications** preference is on.
- The first successful refresh after the extension is enabled sets a baseline and sends no
  transition notification. Failed refreshes before it do not count. The key expiry notification
  is not a transition and can be sent then.
- A failed refresh is not a transition: the next good refresh is compared with the last good one.
  "Previous" below means the last good refresh, and an Unavailable refresh is never compared.
- **Connection lost**: the previous refresh was Connected and this one is not, and no action of
  Tailtray started in the last 30 seconds. The body is the new header label.
- **Login required**: the state becomes Login required or Approval required, from any other
  state. The body is the new header label. Activating the notification opens the menu. The notification is withdrawn once the
  state leaves Login required and Approval required.
- **Exit node offline**: the same peer, by its `ID`, was the exit node in use and online at the
  previous refresh, and is the exit node in use and offline now. The body names it.
- **Key expiring**: `Self.KeyExpiry` is within 7 days and the pair (`Self.ID`, `KeyExpiry`) is not
  among the pairs Tailtray already notified, which it stores in settings, keeping the last 10.
  The body is the warning text. A new key, with a new expiry, or another device of another
  account, can be notified again.
- Activating any other notification opens the menu.

## Preferences

- An Adwaita preferences window with:
  - **Refresh interval**: 5, 10, 30, or 60 seconds, default 10;
  - **Notifications**: a switch, default on;
  - the installed version, from `version-name` of the metadata.
- Changes apply at once, without a save button, and persist across GNOME Shell restarts.
- The settings schema holds `refresh-interval` (unsigned integer, seconds), `notifications`
  (boolean), and `notified-key-expiries` (array of strings, each `<Self.ID> <KeyExpiry>`, empty
  by default).
- A new refresh interval takes effect from the next scheduled refresh.

## Lifecycle

- Enabling the extension adds the icon and starts the first refresh.
- Disabling it cancels the timer, kills every running `tailscale` process it started, destroys
  the menu and the notification source, and leaves no signal connected.
- A command that ends after the extension was disabled changes nothing, even if the extension
  was enabled again in the meantime.
- Locking the screen disables extensions the session mode does not allow; Tailtray does not run
  on the lock screen.

## Security and privacy

- Tailtray stores no credential and reads no file of Tailscale. It knows only what the CLI prints.
- Commands run with an argument array and no shell. No device name, address, or URL goes through
  a shell.
- Tailtray never elevates privileges: it runs no `sudo` and no `pkexec`. A command that needs
  them, such as making the user the operator, is shown for the user to copy and run.
- Only `https://` URLs are opened.
- Tailtray writes only its own settings.

## Out of scope

- Logging in to an additional account, logging out, and removing an account.
- Advertising this device as an exit node or advertising routes.
- Grouping Mullvad exit nodes by country, and the suggested exit node.
- Taildrop, Serve, Funnel, Tailscale SSH, tailnet lock, and Tailscale Drive.
- Opening a terminal or a browser on another device.
- A GNOME Quick Settings toggle.
- A `tailscaled` socket other than the default one, and talking to the LocalAPI directly.
- GNOME Shell versions other than 49, and translations.

## Plans

Each plan is one PR, delivered in order. Its delivery is stamped on the tracking issue, #1.

### TRY-P1: repository, state, header, this device

**Scope**
- The repository, modeled on cr0cK/greenlight: `src/` (extension, prefs, `metadata.json`, GSettings schema, icons), `tests/`, `package.json` with ESLint, `Makefile` with `make check` (schema, `node --check`, `node --test`, `gnome-extensions pack`), `.github/workflows` (PR checks on Fedora 43, PR title lint, release-please as a GitHub App), pre-commit (ESLint, tests, schema, gitleaks, typos), `release-please-config.json` with `src/metadata.json` `version-name`, README, CONTRIBUTING, AGENTS.md, `CLAUDE.md` (`@AGENTS.md`), LICENSE (MIT), PR template.
- `scripts/fake-tailscale`: a stand-in CLI that answers `status --json`, `get --json`, `switch --list --json`, `up`, `down`, `set`, `switch`, and `ping` from fixture files in a scratch directory, records the arguments it was called with, and can be told to sleep or fail per command. `scripts/sandbox.sh` and `scripts/screenshots.sh` put it first on `PATH` when asked to.
- Spec sections: Audience and environment, Reading the state, Connection states, Panel icon, Menu layout, Header, Identity line, Login required and Approval required, Error block, Warnings, This device, Footer, Device names, Relative times, Copying, Actions, Commands and time limits, Errors, Preferences (refresh interval and version), Lifecycle, Security and privacy. Device names and Relative times are pure modules that P3 and P4 reuse.

**Temporary restrictions**
- No Account, Exit node, Settings, or Other devices section: TRY-P2, P3, P4.
- No exit node arrow badge on the panel icon: TRY-P3.
- `tailscale get --json` is not called yet: TRY-P2 adds it with the Settings switches.
- No notifications, no **Notifications** preference, no `notifications` and `notified-key-expiries` keys: TRY-P5.

**Prototype** (first, on a real `tailscaled` with the user as operator, then throwaway)
1. Precondition: record the user's preferences (`tailscale get --json`), set non-default ones, then record those (`tailscale set --accept-routes=true --shields-up=true --exit-node-allow-lan-access=true`, and an exit node when the tailnet has one). From `Stopped`, `tailscale up` with no argument exits 0 and leaves `tailscale get --json` unchanged. Pass: exit 0 and the JSON before and after is equal; the time to `Running` is reported, not judged. Fail: a `blocked` stamp on the tracking issue, since the header switch has no other safe command. Restore the preferences recorded first, afterwards.
2. `tailscale down` exits 0, reaches `Stopped`, with the same preference check.
3. On GNOME Shell 49, `Main.osdWindowManager.showOne(monitor, icon, label)` with `edit-copy-symbolic` shows on the current monitor (it shows nothing without an icon). Fail: outbox entry with the replacement.

**Acceptance**
- `node --test` covers the pure modules: state derivation from every `BackendState` and from each failure, the error text table in order, warnings (filtering `Tailscale is stopped.`, key expiry at 8 days, 7 days, 23 h, past, missing, zero time), identity line with missing parts, relative times at every boundary, and This device rows with missing addresses.
- `make check` and `npm run lint` pass; CI is green.
- In a headless GNOME Shell 49 with `scripts/fake-tailscale`, screenshots of the menu in Connected, Disconnected, Connecting, Login required, Approval required, and Unavailable (CLI missing, service down, access denied), and of the panel icon in each; no `JS ERROR` or `JS WARNING` in the shell log.
- Driving the switch calls the fake with exactly `up` then `down`; activating an address copies it (read back from `St.Clipboard`) and closes the menu.
- Disabling the extension while a fake command sleeps kills it (no `tailscale` child left), and leaves no timer (checked by re-enabling and counting refreshes); a fake reply delayed past a disable and re-enable changes nothing in the new instance.
- With the fake: three refresh requests during a slow refresh run exactly one more refresh; a new refresh interval applies from the next scheduled refresh; a refresh started before an action ended is discarded (slow status, fast `down`); a refresh that flips the switch calls no command; a failing `status` shows Unavailable; a sleeping read is killed at 30 s (time limit lowered by an environment variable for the test).
- Login required shows only the copyable `tailscale up` command, the warnings, and the footer, with or without `AuthURL`; Approval required shows its line and **Open admin console**; `tailscale login` is never called.
- A fake `up` that sleeps past its time limit while `status` answers `NeedsLogin` leaves no error block, and the menu shows Login required; a failing `down` shows its error only once its follow-up answered.
- A refresh interval chosen in the preferences window is still set after restarting the headless shell, and the refresh timer follows it.

**Technical notes**
- The repository, the toolchain, and CI are new in this plan: the checks of the project settings (`npm run lint`, `make check`, headless GNOME Shell) apply from its own PR on, and the plan keeps `docs/specs/README.md` in step if a command changes.
- **GJS subprocess**: `Gio.Subprocess` with `STDOUT_PIPE | STDERR_PIPE`, `communicate_utf8_async`, and a `Gio.Cancellable` per call; on timeout or disable, `force_exit()`. Greenlight's `_runGh` is the pattern to copy (`src/extension.js` there), with a per-call timeout argument. No command needs streamed output: Tailtray never runs `tailscale login`, which would switch to a new empty profile (`cmd/tailscale/cli/login.go`).
- **Stale callbacks**: give each enable an instance generation and each refresh a sequence number bumped by every action; a completion whose generation or sequence is stale returns without touching anything.
- **`tailscale` exit codes**: `status --json` exits 0 in `Stopped` and `NeedsLogin`; parse stdout first, then the exit code. When `tailscaled` is down it exits 1 with `failed to connect to local tailscaled` on stderr.
- **`tailscale up` with any flag is dangerous**: the CLI refuses or rewrites preferences unless every non-default flag is repeated. Only the bare `tailscale up` takes the simple path that sets `WantRunning`. The prototype checks this.
- **JSON fields used** (tailscale 1.104): `BackendState`, `AuthURL`, `Health`, `CurrentTailnet.Name`, `Self` (`DNSName`, `TailscaleIPs`, `UserID`, `KeyExpiry`), `User[<id>].LoginName`, `Peer[*]` (`DNSName`, `HostName`, `OS`, `Online`, `LastSeen`, `TailscaleIPs`, `ExitNode`, `ExitNodeOption`, `Location`). `get --json` keys: `accept-routes`, `accept-dns`, `shields-up`, `exit-node-allow-lan-access`. `switch --list --json`: `[{id, nickname, tailnet, account, selected}]`. Missing fields are normal; treat every one as optional.
- **Zero times**: Go's zero time prints as `0001-01-01T00:00:00Z`; treat it as missing.
- **Menu**: keep persistent sections and update rows in place, as greenlight does (`_buildMenu()` once, sections rebuilt), so open submenus and ping results survive refreshes. GNOME Shell cannot nest a `PopupSubMenuMenuItem` inside another submenu, which is why devices expand inside a scroll view in the main menu, not inside a submenu.
- **Switch rows**: in GNOME Shell 49, `PopupSwitchMenuItem.setToggleState()` sets the switch's `state`, whose `notify::state` emits `toggled` (`js/ui/popupMenu.js`), so a rendering update looks like a user's toggle. Wrap every update from a refresh in a rendering flag, and have the `toggled` handler return while it is set. `PopupSwitchMenuItem.activate()` toggles and then calls `PopupBaseMenuItem.activate()`, which closes the menu: override `activate` to toggle without calling the parent. The header switch needs both in this plan; the Settings and **Allow LAN access** switches reuse them.
- **Icons**: the glyph is a symbolic SVG drawn for this project (`src/tailtray-symbolic.svg`), outlined and filled variants included; symbolic icons are recolored by the theme, so the yellow and red dots are a small `St.Widget` drawn over the panel button's corner, not part of the SVG, and the dimmed states use `opacity`.
- **Clipboard**: `St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, value)`.
- **OSD**: `Main.osdWindowManager.showOne(global.display.get_current_monitor(), Gio.ThemedIcon.new('edit-copy-symbolic'), label)` on 49; `OsdWindow.show()` returns early without an icon (`js/ui/osdWindow.js`).
- **Headless verification**: reuse greenlight's AGENTS.md recipe (headless Wayland shell in `dbus-run-session`, keyfile GSettings, unsafe-mode helper for Eval and Screenshot) with `scripts/fake-tailscale` first on `PATH`, so tests never touch the real tailnet.
- **Public repository hygiene**: fixtures and screenshots use fictional names (`example.org`, `tail1234.ts.net`, `100.64.x.y`), never a real tailnet.

### TRY-P2: Account and Settings

**Scope**: spec sections Account and Settings, and the `tailscale get --json` call of Reading the state.

**Temporary restrictions**
- No Exit node or Other devices section: TRY-P3, P4.
- No notifications: TRY-P5.

**Acceptance**
- Unit tests: profile rows from `switch --list --json` (selected, missing account), switch values from `get --json` (missing key makes the switch insensitive).
- Headless GNOME Shell with the fake: activating another profile calls `switch <id>`; activating the selected one calls nothing; each switch calls `set --<flag>=<true|false>`; the menu stays open; the profile list is requested once per menu opening and once after each switch, not per refresh (call count in the fake's log); after a switch with the menu open, the new profile is checked.
- Profile list states: `Loading…` while the first answer sleeps, the previous profiles insensitive while a later one sleeps, `Could not list accounts` when it fails.
- While a slow `switch` runs, every action row is insensitive and the chosen profile shows `Switching…`; no second action command reaches the fake.
- A switch row shows the requested value while its `set` runs, and after it the value the next `get` returns: the old one when the fake `set` fails without changing it; insensitive when that `get` fails.
- A periodic refresh that completes while a slow `switch` is pending, or just after the command ended and before the follow-up answered, leaves `Switching…` and the locks in place; the follow-up's answer then ends them.
- Closing the menu while the refresh after a failing `set` sleeps, then reopening once it answered, shows no error block.
- A failing `switch` whose next refresh answers `NeedsLogin` shows Login required; a later refresh to `Running`, with the menu still open and no new action, shows no error block and then calls `switch --list --json` once. In Login required, opening the menu does not call `switch --list --json`. The same holds with `NeedsMachineAuth`.
- A failing `get` keeps the state Connected, makes the three switches insensitive, and shows no error block.
- Screenshots of both submenus expanded.

**Technical notes**
- See TRY-P1 for the subprocess, menu, and headless notes.
- **Switch rows**: reuse TRY-P1's rendering flag and `activate` override, so a refresh never runs a command and toggling keeps the menu open.

### TRY-P3: Exit node

**Scope**: spec section Exit node, and the exit node badge of Panel icon.

**Temporary restrictions**
- No Other devices section: TRY-P4. Peers with `Location` are still listed under Exit node.
- No notifications: TRY-P5.

**Acceptance**
- Unit tests: exit node list (sorting, offline insensitive except the one in use, the node in use listed and checked even without `ExitNodeOption`, IPv6 fallback, no address insensitive, `None` checked with no exit node, `None available` only with no option and none in use).
- Headless with the fake: choosing a node calls `set --exit-node=<IPv4>`, **None** calls `set --exit-node=`, the checked row calls nothing, **Allow LAN access** calls `set --exit-node-allow-lan-access=<bool>`; the icon shows the badge while an exit node is in use, offline or not.
- The chosen row shows `Setting…` while a slow `set` runs; 300 fake exit nodes scroll within the 280 px submenu, and a refresh updates their rows in place (rows kept by peer `ID`, expanded submenu kept open).
- Screenshots: submenu expanded with an online, an offline, and a checked offline node; the panel icon with the badge.

**Technical notes**
- See TRY-P1 for the subprocess, menu, and headless notes. The badged glyph is its own symbolic SVG (`src/tailtray-exit-symbolic.svg`, glyph and arrow in one image), set as the panel icon's `gicon` on refresh; the panel shows one icon in every state.

### TRY-P4: Other devices

**Scope**: spec section Other devices, using the Device names and Relative times modules of TRY-P1.

**Temporary restrictions**
- No notifications: TRY-P5.

**Acceptance**
- Unit tests: device list (excludes `Location` peers, online first, case-insensitive names, `HostName` fallback, counts), ping parsing of (stdout, stderr, exit code) for a direct pong, a DERP pong, a peer relay pong, a pong with a non-zero exit code, a timeout, and garbage. Fixtures come from real `tailscale ping -c 1 --until-direct=false` output captured on a live tailnet when that path is available, otherwise built from the format strings of `cmd/tailscale/cli/ping.go` at v1.104.2; either way without real names or addresses.
- Headless with the fake: expanding a device collapses the previous one; **Ping** calls `ping -c 1 --until-direct=false --timeout 5s <IPv4>` and shows each result; **Ping** is insensitive for an offline device; a refresh while a device is expanded keeps it expanded and keeps its ping result; 60 fake devices scroll within 280 px; closing the menu during a slow ping kills it, and reopening shows no result; two devices ping at once.
- Screenshots: one device expanded with a ping result.

**Technical notes**
- See TRY-P1 for the subprocess, menu, and headless notes.
- **Ping**: `--until-direct` defaults to true, so `-c 1` can exit 1 with `direct connection not established` after a DERP pong; Tailtray passes `--until-direct=false` and still parses the pong before the exit code.

### TRY-P5: Notifications

**Scope**: spec section Notifications, and the **Notifications** preference and the `notifications` and `notified-key-expiries` settings keys of Preferences.

**Acceptance**
- Unit tests: a pure transition function over (previous good state, current state, last Tailtray action time, notified expiry pairs) for each notification, the baseline on the first successful refresh after failed ones, a failed refresh between two good ones, the 30-second action window, exit node A online to exit node B offline (no notification), and the pair list capped at 10.
- Headless with the fake: each notification appears once in the message tray for its transition; none with the preference off; a key expiry notification is not repeated after restarting the shell, nor after switching accounts back and forth; the Login required notification is withdrawn once the state leaves it; activating any notification opens the menu (checked through Eval); the **Notifications** preference is still set after restarting the shell; after a notification is dismissed or activated, the next transition still notifies; withdrawing an already dismissed Login required notification logs no error.

**Technical notes**
- See TRY-P1 for the subprocess, menu, and headless notes.
- **Notifications**: GNOME 49 `MessageTray.Source` and `MessageTray.Notification` with `Main.messageTray.add(source)`; check the 49 constructor signatures (they take an object of properties since 46). A source destroys itself when its last notification goes (`Source._onNotificationDestroy` in `js/ui/messageTray.js`), and activating a non-resident notification destroys it: create the source when a notification is first needed, drop it on its `destroy` signal, and clear the reference to the Login required notification on its `destroy`, so withdrawing it never touches a destroyed object.
