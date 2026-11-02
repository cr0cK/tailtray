# AGENTS.md

Guidance for AI agents working on Tailtray, a GNOME Shell 49 extension that shows and controls
the local Tailscale node through the `tailscale` CLI. Read CONTRIBUTING.md for the human
workflow and `docs/specs/TRY.md` for the product contract; this file holds what the code does not
tell you.

## Layout

Everything that ships lives in `src/`; `make check` packs it into the extension zip and picks up
new `src/*.js` and `src/*.svg` files on its own.

| Path | Role |
|---|---|
| `src/extension.js` | Panel icon, menu, copy and OSD; renders the engine's model |
| `src/prefs.js` | Adwaita preferences window; every change applies at once |
| `src/engine.js` | Refresh queue, action and follow-up rules, error decisions (pure; commands and timers injected) |
| `src/runner.js` | `Gio.Subprocess` runner: argument arrays, time limits, kill on destroy |
| `src/status.js` | Connection states, status parsing, header, panel icon and layout models (pure) |
| `src/errors.js` | The error text table (pure) |
| `src/warnings.js` | Health and key expiry warnings (pure) |
| `src/devices.js` | Device names, sorting, copyable rows (pure) |
| `src/time.js` | Relative times (pure) |
| `src/schemas/` | GSettings schema; settings live under `org.gnome.shell.extensions.tailtray` |
| `tests/` | `node --test` suites for the pure modules; `tests/fixtures/` holds fictional CLI output |
| `docs/specs/` | Product contracts (`TRY.md`) and their delivery process; `docs/specs/README.md` holds the project settings |
| `scripts/fake-tailscale` | Stand-in CLI answering from fixture files, recording calls (see its header) |
| `scripts/verify.sh` | Headless GNOME Shell scenarios against the fake; prints PASS or FAIL per check |
| `scripts/screenshots.sh` | Regenerates `docs/screenshots/` from the fake |
| `scripts/sandbox.sh` | Windowed, isolated GNOME Shell running the checkout; `--fake` uses the fake CLI |
| `scripts/lib/headless.sh` | Shared headless shell helpers (boot, Eval, pointer, screenshots, fake control) |

The pure modules import nothing from `gi://`, so `node --test` covers them. Keep new logic there
when it can live without GNOME APIs.

## Commands

```sh
npm ci && pre-commit install --install-hooks   # once
npm run lint                                   # ESLint
make check                                     # schema, parse, unit tests, zip in dist/
scripts/verify.sh 2>/dev/null                  # headless shell scenarios (about 2 minutes)
scripts/sandbox.sh --fake                      # try it in a windowed GNOME Shell
```

`npm run lint` and `make check` must pass before you declare work done, and a user-visible
change also passes `scripts/verify.sh` with its screenshots looked at.

## Verify UI changes in a real GNOME Shell

Unit tests do not prove the menu works. `scripts/verify.sh` runs the extension in a headless GNOME
Shell on a private D-Bus session, with `scripts/fake-tailscale` first on `PATH` so nothing reaches
a real tailnet, and writes screenshots to `dist/verify-shots/`. Extend it with a scenario for
every user-visible behavior you add, and look at the screenshots. The recipe, if you need your own:

- Launch `gnome-shell --headless --wayland --no-x11 --wayland-display=<short-name>
  --virtual-monitor 1280x800` inside `dbus-run-session`, with `XDG_DATA_HOME`, `XDG_CONFIG_HOME`
  and `XDG_CACHE_HOME` pointing at a scratch directory and `GSETTINGS_BACKEND=keyfile`. Seed
  `org.gnome.shell enabled-extensions` in that keyfile, and never touch the user's dconf.
- The Wayland socket path must stay under 108 bytes, so keep the display name short and leave
  `XDG_RUNTIME_DIR` at its usual `/run/user/<uid>`.
- `org.gnome.Shell.Eval` and `org.gnome.Shell.Screenshot` need unsafe mode. Enable it with a
  throwaway helper extension in the scratch directory whose `enable()` sets
  `global.context.unsafe_mode = true`. Never ship that helper. It makes the Shell show a banner:
  destroy the message tray sources before a screenshot.
- Eval has `Main`, `Gio`, `GLib`, and `global`, but not `St` or `Clutter`: use `imports.gi.St`.
- Reach the extension from Eval with
  `Main.extensionManager.lookup('tailtray@cr0ck.github.io').stateObj`.
- Drive input with a Clutter virtual device, created before any menu opens (a device that appears
  while a menu is open closes it):
  - the first motion of a new device lands at an edge of the screen: move it once and discard that;
  - send pointer motion in its own step before clicking, or the click lands on the old position;
  - `notify_button` takes Clutter button numbers (`Clutter.BUTTON_PRIMARY` = 1).
- A real click through the virtual device reaches the same code as a user's click; calling
  `item.activate(null)` from Eval is enough for rows whose click path is already covered.
- GNOME Shell caches extension modules. After editing code, restart the headless shell (the script
  packs and boots a new one each run); disabling and re-enabling keeps running the old code.
- The preferences window is a separate process (`gnome-extensions prefs`); its default window
  is 640 by 576, and the script clicks at offsets from its frame.
- Look at the screenshots, and grep the shell log for `JS ERROR` and `JS WARNING`.

`scripts/sandbox.sh` uses the mutter devkit instead. Do not pass `--virtual-monitor` there: the
devkit shows its own monitor, and the panel would land on an invisible one.

## GJS, St, and Clutter pitfalls

- `Gio.Cancellable.connect(callback)` is `g_cancellable_connect`, not a signal connect.
- `GSettings.delay()` is permanent: the object stays in delay-apply mode after `apply()`, and
  later writes through it are never saved. Never call `delay()` on the extension's settings.
- The Shell theme has no `dim-label` class (it is GTK only). Dim text with `opacity`.
- `St.Label` ellipsizes by default, which silently disables `line_wrap`. Use `wrapLabel()`.
- A `PopupBaseMenuItem` with `reactive: false` renders as insensitive (greyed). For a static
  block, use `{activate: false, hover: false, can_focus: false}`.
- `PopupSwitchMenuItem.setToggleState()` emits `toggled` like a click does: wrap every update from
  a refresh in the `_rendering` flag, and have the handler return while it is set. Its
  `activate()` closes the menu through its parent: override it (see `HeaderItem`).
- The menu closes on the `activate` signal of any item. A row that must leave it open (Refresh now)
  overrides `activate()` and never emits the signal.
- A subclass of a Shell item needs `GObject.registerClass`.
- A missing executable is `GLib.SpawnError.NOENT`, not a `Gio.IOErrorEnum`.
- Menus follow the colour scheme (light by default in GNOME 49), so text colours come from
  `PALETTES` by `St.Settings.get().color_scheme`; a fixed pale yellow is unreadable on white.
- A switch animates for a moment after `setToggleState`: wait before a screenshot.
- The menu is built once in `_buildMenu()` from persistent items; refreshes update them in place
  and rebuild a section only when its content changed. Do not go back to `menu.removeAll()`:
  open submenus must survive a refresh.

## tailscale calls

- Always pass argument arrays through `CommandRunner.run(args, timeoutSeconds)`, never a shell
  string. Never run `tailscale login` (it starts a new empty profile), never `up` with a flag
  (it rewrites preferences), never `sudo` or `pkexec`.
- `status --json` exits 0 in Stopped and NeedsLogin; parse stdout before the exit code. A daemon
  that is down exits 1 with `failed to connect to local tailscaled`.
- `tailscale` is looked up on `PATH` once, when the extension is enabled; the headless scripts
  change `PATH`, then reload the extension.
- `TAILTRAY_TIMEOUT_SECONDS` replaces every time limit; the headless tests lower it. It is read
  when the extension is enabled.
- Every completion checks that its engine is not destroyed: an engine lives for one enable, and a
  reply that arrives after a disable, even after a re-enable, must touch nothing.

## Versions, releases, and docs

- The UUID is `tailtray@cr0ck.github.io`. Never change it casually: changing it makes users
  reinstall.
- release-please owns `CHANGELOG.md`, `package.json` `version`, and `src/metadata.json`
  `version-name`. Do not edit them by hand. `metadata.json` must not get an integer `version`:
  extensions.gnome.org sets it.
- The repository is public: never put session links, local paths, or real tailnet names,
  hostnames, addresses or login names in commits, PR texts, docs, screenshots, or test
  fixtures. Fixtures use `example.org`, `tail1234.ts.net`, `100.64.x.y`, and `fd7a:115c:a1e0::`.
- Commits and PR titles use Conventional Commits. PRs are squash-merged, so the PR title is the
  commit release-please reads. `feat` bumps the minor version, `fix` the patch, and breaking
  changes the major version. `docs`, `test`, `build`, `ci`, `chore`, and `style` are hidden
  changelog sections and never trigger a release.
- release-please runs as a GitHub App (`RELEASE_APP_CLIENT_ID` variable,
  `RELEASE_APP_PRIVATE_KEY` secret), not with GITHUB_TOKEN: GitHub holds `pull_request`
  workflows on PRs opened by GITHUB_TOKEN for manual approval.
- release-please only rewrites an open release PR when its release notes change. A CI or config
  fix merged as a hidden type never reaches that branch: run `gh pr update-branch <release PR>`.
- The gitleaks pre-commit hook only scans staged changes. CI scans the full history with a
  checksum-pinned gitleaks binary; bump its version and SHA-256 together.
- A user-visible change updates README.md in the same PR. When it changes the menu or the
  preferences window, run `scripts/screenshots.sh`, look at the new images, and commit them;
  extend the fixtures rather than capturing real data. Source, docs, and UI strings are in English.
- A defect found outside the task at hand becomes a GitHub issue with its reproduction, not a
  wider PR.
