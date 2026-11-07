---
code: SRV
status: done
version: v0.2
created: 2026-11-07
builds-on: TRY
tracking: "#16"
---

# Tailtray — SRV specification

SRV shows, in the Tailtray menu, what this device shares with Tailscale Serve and Funnel: one row
per shared URL or TCP port with its local target, a **Public** mark on what Funnel opens to the
internet, copying a share's URL, and stopping a share. It builds on TRY, whose rules all still
hold except these, which SRV replaces: Serve and Funnel leave TRY's Out of scope, Menu layout
gains the Shared section between This device and the controls, stopping a share joins the
actions of TRY's Actions, and the whole menu gains the colors of Menu colors and a `Connection`
caption over the controls. Nothing outside the menu changes: the panel icon and the notifications
stay as TRY defines them.

The mockup, [`mockups/SRV.html`](mockups/SRV.html), shows every state of the Shared section, in
the colored menu; open it in a browser. Where it and the rules disagree, the rules win.

## Reading the shares

- A refresh whose `tailscale status --json` answers Connected, and that still counts (see TRY's
  Reading the state), runs `tailscale serve status --json` after `tailscale get --json`. The calls
  run one after the other.
- It is a read: it needs no operator.
- In any other state it does not run, and the Shared section is hidden.
- When it fails, is killed by its time limit, or prints JSON Tailtray cannot read, the refresh
  still succeeds: the Shared section shows its failure line (see Shared section), and nothing else
  changes.
- An output of `null` or `{}` is a good read with no share. Any other output that is not a JSON
  object is JSON Tailtray cannot read.

## Shares

A share is one entry Tailtray derives from the serve config that `tailscale serve status --json`
prints.

- **Web share**: one per handler `Web["<host>:<port>"].Handlers["<mount>"]` whose
  `TCP["<port>"]` has `HTTPS` or `HTTP` true. Its scheme is `https` when `HTTPS` is true, otherwise
  `http`.
- **TCP share**: one per `TCP["<port>"]` with a non-empty `TCPForward`. It is TLS-terminated when
  `TerminateTLS` is non-empty. Its host is this device's MagicDNS name (`Self.DNSName` without its
  trailing dot); without one, TCP shares are not listed.
- A **background** share comes from the top level of the config. A **foreground** share comes
  from a config under `Foreground["<session>"]`: a `tailscale serve` or `tailscale funnel` running
  in a terminal without `--bg`. Both are read with the rules above, each from its own config.
- A share is **public** when `AllowFunnel["<host>:<port>"]` is true in the config it comes from.
- Everything else in the config is ignored: a `Web` entry whose port has neither `HTTPS` nor
  `HTTP`, `Services` (Tailscale Services), and any other key.
- Every field is optional. A missing field, or one of the wrong JSON type, reads as empty or
  false. A port that is not an integer from 1 to 65535 makes its entry ignored, so no command ever
  carries it.

### URL, label, and target

| Share | URL (copied) | Label (shown) |
|---|---|---|
| Web | `<scheme>://<host>[:<port>]<path>` | the URL with `<host>` cut to its first label |
| TCP | `<host>:<port>` | `tcp://<host first label>:<port>` |

- `:<port>` is left out for `https` on 443 and `http` on 80. `<path>` is the mount, left out when
  it is `/`. In the URL, each segment of the mount between `/` is percent-encoded as
  `encodeURIComponent` does, so `/a#b` copies as `/a%23b`; the label shows the mount as it is, and
  `--set-path` takes it as it is.
  Examples: `http://workstation.tail1234.ts.net:4173`,
  `https://workstation.tail1234.ts.net/docs`, label `https://workstation/docs`.
- The target is the first non-empty field of the handler, in this order: `Proxy` as it is, `Path`
  as it is, `Text` as `text`, `Redirect` as `redirect <Redirect>`. A handler with none has no
  target. A TCP share's target is its `TCPForward`.

### Order

- Background shares first, then foreground ones by session key in code-point order. Within each
  config, by port ascending, then host, then mount, both in code-point order.
- A TCP share has no mount: a Web share and a TCP share on the same port and host list the Web
  share first. Tailscale never writes such a config, since it refuses a Web share on a port that
  serves TCP.

## Shared section

- It is its own group in TRY's Menu layout, between This device and the controls, so the menu has
  six groups. The separator rule of Menu layout applies unchanged.
- It shows in Connected only, when there is at least one share or the read failed. With a good
  read and no share, it is hidden.
- A caption `Shared from this device`, then one row per share, in a scrolling area at most four
  share rows high; a fifth share scrolls.
- A share row's width does not depend on its text: its two text lines sit in a column exactly
  22 em wide, and what is longer is ellipsized as below.
- A row has two lines. Left of them, the share's tile (see Menu colors); right of them, a copy
  icon and the stop button when the share has one, both centered on the row's height.
  - The first line is the label, then a **Public** pill when the share is public. A label that
    does not fit is ellipsized at its end; the pill, the copy icon, and the stop button always
    stay whole.
  - The second line, dim and smaller, is `→ <target>`, ellipsized at its end when it does not
    fit. A share with no target has an empty second line.
- Activating the row copies the share's URL, as TRY's Copying says.
- The stop button is an icon button with the `media-playback-stop-symbolic` icon, in the error
  color of Menu colors, and the accessible name `Stop sharing <URL>`. Activating it stops the share (see Stopping a share); it
  does not copy.
- Only a background share whose host is this device's MagicDNS name, and whose port no other
  host of the background config serves, has a stop button. A foreground share has none: it ends
  with the command running in its terminal. A share of another host has none: the CLI only
  removes shares of this device's name. A share whose port another host also serves has none:
  removing its port's last handler also removes `TCP["<port>"]`, which the other host needs.
- When the read failed, the caption is followed by one insensitive dim row with a grey
  `dialog-warning-symbolic` tile and `Could not read what this device shares`, and no other row.
- A refresh while the menu is open updates the rows in place, as TRY's Reading the state says for
  the other sections. A share keeps its row from one refresh to the next when its key is the
  same: its config (`background`, or the `Foreground` session key), its kind (Web or TCP), its
  host, its port, and, for a Web share, its mount. The pending stop is tied to that key too.

## Stopping a share

- Stopping a share is an action, with every rule of TRY's Actions: one action at a time, its
  follow-up refresh, every action row insensitive while it is pending, its error decided once the
  follow-up answers, and the menu stays open. While any action is pending, every stop button is
  insensitive; the share rows stay sensitive, since copying is not an action. Stopping counts as a
  Tailtray action for TRY's Connection lost notification.
- The command depends on the share:

| Share | Command |
|---|---|
| Web, `https` | `tailscale serve --https=<port> --set-path=<mount> off` |
| Web, `http` | `tailscale serve --http=<port> --set-path=<mount> off` |
| TCP | `tailscale serve --tcp=<port> off` |
| TCP, TLS-terminated | `tailscale serve --tls-terminated-tcp=<port> off` |

- A public share stops with the same command. Tailtray never runs `tailscale funnel`. For a Web
  share, Tailscale removes the Funnel of its port with the port's last handler; for a TCP share it
  leaves `AllowFunnel` in place, which shows nothing since the share is gone.
- While it is pending, the row's second line reads `Stopping…`, with no arrow. The follow-up renders the menu from its
  own reads, with every rule above: the row is gone when the stop worked and back to its target
  otherwise; the failure line replaces every row when its share read failed; the section is hidden
  when the state is no longer Connected.
- Stopping needs the user to be the Tailscale operator; when they are not, the error is the
  operator one of TRY's Errors.
- When the config left after the stop still holds a `Path` handler or a Unix socket target,
  Tailscale also requires local admin rights and refuses with `must be root, or be an operator and
  able to run 'sudo tailscale' to serve a path or Unix socket`. Tailtray shows it as any other
  error of TRY's Errors: its first line.
- There is no confirmation: one activation stops the share.

## Menu colors

These rules apply to the whole menu, in every state, and in both the light and the dark Shell
styles.

- **Header**: in Connected, the header label is green, whatever it reads, `Disconnecting…`
  included while a `tailscale down` is pending. The other states keep TRY's colors: yellow
  for Login required and Approval required, red for Unavailable, the regular text color otherwise.
- **Captions**: the captions `This device`, `Shared from this device`, `Connection`, and
  `Other devices` are bold, in the Shell's accent color. In the Other devices caption, only
  `Other devices` takes it; ` · <online> of <total> online` stays dim. The caption
  `No other devices` takes it whole.
- **Connection caption**: the controls group (Account, Exit node, Settings) starts with the
  caption `Connection`, shown whenever the group shows.
- **Tiles**: these rows start with a tile, a 24-pixel square with rounded corners, filled with a
  color, holding a white 14-pixel symbolic icon or a white bold character:

| Row | Color | Content |
|---|---|---|
| This device: MagicDNS name | blue | `network-workgroup-symbolic` |
| This device: IPv4 address | blue | `4` |
| This device: IPv6 address | blue | `6` |
| Share, background, not public, Web | teal | `send-to-symbolic` |
| Share, public | orange | `web-browser-symbolic` |
| Share, background, not public, TCP | brown | `network-wired-symbolic` |
| Share, foreground, not public | grey | `utilities-terminal-symbolic` |
| Shares failure line | grey | `dialog-warning-symbolic` |
| Account | purple | `avatar-default-symbolic` |
| Exit node | orange | `network-vpn-symbolic` |
| Settings | slate | `preferences-system-symbolic` |
| Refresh now | green | `view-refresh-symbolic` |
| Preferences | grey | `preferences-other-symbolic` |

- The colors are GNOME's palette: blue `#3584e4`, teal `#2190a4`, orange `#e66100`, brown
  `#865e3c`, grey `#77767b`, purple `#9141ac`, slate `#6f8396`, green `#26a269`. The green of the
  header label is `#33d17a` in the dark style and `#26a269` in the light one; the error color of
  the stop button is `#ff7b63` in the dark style and `#c01c28` in the light one.
- No other row gets a tile: the rows inside the Account and Exit node submenus, the Settings
  switches, the device rows, which keep their dots, the error block, the warnings, and the Login
  required and Approval required lines stay as TRY defines them.
- An insensitive row dims its tile with the rest of the row.

## Security and privacy

- The port and the mount go to the CLI as separate arguments of an argument array, never through
  a shell.
- Tailtray never opens a share's URL, never starts a share, and changes a share only by stopping
  it.

## Out of scope

- Starting or changing a share, and opening its URL.
- Stopping a foreground share, or every share at once (`tailscale serve reset`).
- Tailscale Services (`Services`, `--service`, `--tun`).
- A panel icon badge or a notification about shares.
- Showing shares in any state other than Connected.
- Stopping a share from the keyboard: menu key navigation stops on rows, not on the stop button,
  so a keyboard user copies a share but stops it with the CLI. The button keeps its accessible
  name.

## Plans

Each plan is one PR, delivered in order. Its delivery is stamped on the tracking issue, #16.

### SRV-P1: Shared section

**Scope**: every section of this spec, Menu colors included, which changes every state of the
menu, not only the Shared section.

**Temporary restrictions**: none.

**Acceptance**
- `node --test` covers a new pure module `src/serve.js`: shares from a config with a Web share on
  `http` and on `https` (443 without port, another port with it), several mounts on one port, a TCP
  share and a TLS-terminated one, a public share, a foreground share, a `Web` entry whose port has
  neither `HTTPS` nor `HTTP` (ignored), `Services` (ignored), a host other than this device's (no
  stop), two hosts on one port (no stop on either), each target kind and a handler with none,
  `null`, `{}`, an array, wrongly typed fields, ports `0`, `65536` and `abc` (ignored), and output
  Tailtray cannot read; the order, including the same shares in another JSON key order; the URL
  and label of each kind, with mounts `/a#b`, `/a?b`, `/50%` and `/é` encoded in the URL and raw in
  the label and the stop command; the stop command of each kind.
- `node --test` covers the engine (`tests/engine.test.js`): `serve status --json` runs after
  `get --json` in Connected only; it never runs in a refresh already known to be discarded; its
  failure or timeout keeps the refresh good and sets only the share failure; a `get --json`
  failure followed by a good share read shows the shares; a share read delayed past an action
  start or a disable changes nothing.
- `scripts/fake-tailscale` answers `serve status --json` from `serve.json`, and `serve ... off`
  removes the matching share from it as Tailscale does: a Web share's last handler takes its port's
  `TCP` and `AllowFunnel` entries with it; a TCP share removes only its `TCP` entry. The read and
  the stop have their own control keys, `serve-status` and `serve-off`, honoring `.sleep`, `.fail`,
  `.stdout` and `.noeffect` like the other commands. Without `serve.json`, the read prints `null`.
  The fake takes this device's name from `Self.DNSName` of `status.json`, without its trailing
  dot, parses `--https=`, `--http=`, `--tcp=`, `--tls-terminated-tcp=`, `--set-path=` and the
  final `off`, and, when nothing matches, exits 1 with `error: failed to remove web serve: handler
  does not exist` for a Web flag and `error: failed to remove TCP serve: serve config does not
  exist` for a TCP one, as Tailscale does.
- Headless GNOME Shell with the fake (`scripts/verify.sh`): the section with a public Web share on
  443, a Web share on 4173, a TCP share on 5432, and a foreground share on 8443, in that order, the
  one Order gives; activating a row copies its URL (read back from
  `St.Clipboard`) and closes the menu; a real pointer click on the stop button of each kind,
  through the Clutter virtual device of AGENTS.md, calls exactly the command of Stopping a share,
  once, leaves the clipboard unchanged, and keeps the menu open; the row shows `Stopping…` while a
  slow stop runs, with every other action row and stop button insensitive and the share rows still
  copyable; a failing stop shows its error after the follow-up and the row keeps its target; a
  failing stop whose follow-up share read also fails shows the error and the failure line; a stop
  failing with `Access denied` shows the operator error, and one failing with the local admin text
  shows that line; a foreground share and another host's share have no stop button; a failing
  `serve status` shows the failure line and keeps every other section; with no share the section
  and its separator are hidden; in Disconnected `serve status` is never called (fake's log); 30
  shares scroll within the height of four share rows with the last row reachable, and a refresh while scrolled, with
  a device expanded, keeps the scroll position and the expanded device; on a 1920x1080 virtual
  monitor, with 30 shares and 60 devices, the footer is on screen or reachable by scrolling the
  menu, and both scrolling areas scroll with the wheel; a share whose target is a 200-character
  path leaves the menu as wide as a share whose target is `127.0.0.1:1`.
- `npm run lint` and `make check` pass; CI is green; no `JS ERROR` or `JS WARNING` in the shell
  log.
- Headless screenshots in Connected, Disconnected, Login required, and Unavailable, in the dark
  and the light Shell styles, show every tile, caption, and header color of Menu colors, and a
  share whose target is too long is ellipsized on its second line.
- Through Eval, in both styles (the color scheme switched as `scripts/verify.sh` already does), the
  theme node of each tile, caption, the header label in Connected, and the stop button returns
  the background or foreground color Menu colors gives
  (`get_theme_node().get_background_color()`, `get_foreground_color()`).
- `scripts/screenshots.sh` regenerates every screenshot of `docs/screenshots/`, since Menu colors
  changes all of them, and adds `docs/screenshots/menu-shared.png`; the README shows it, and
  AGENTS.md's layout table lists `src/serve.js` and the two stylesheets.
- The zip `make check` builds holds `stylesheet-dark.css` and `stylesheet-light.css`
  (`unzip -l`).

**Technical notes**
- See TRY-P1 for the subprocess, menu, and headless notes.
- **Engine**: `src/engine.js` `_refresh` reads `get --json` when the state shows Settings; add the
  `serve status --json` read right after it, when the state is Connected and the refresh still
  counts, and keep its result on the model next to `prefs`. A failed read is a model value, not a
  refresh failure.
- **JSON** (tailscale 1.104.2, `ipn/serve.go`): `ServeConfig` is `{TCP, Web, Services,
  AllowFunnel, Foreground}`; `TCP` keys are port strings, values `{HTTPS, HTTP, TCPForward,
  TerminateTLS}`; `Web` keys are `"<host>:<port>"`, values `{Handlers: {<mount>: {Path, Proxy,
  Text, Redirect}}}`; `AllowFunnel` keys are `"<host>:<port>"`; `Foreground` values are nested
  `ServeConfig`s. With no config, `serve status --json` prints `null`
  (`cmd/tailscale/cli/serve_v2.go`, `runServeStatus`).
- **Stopping** (`serve_v2.go`, `removeWebServe`): without `--set-path`, `off` removes every mount
  of the port and asks for confirmation when there are several, so Tailtray always passes
  `--set-path=<mount>`. `off` never touches the foreground configs. `RemoveWebHandler` deletes the
  port's `AllowFunnel` with its last handler; `RemoveTCPForwarding` does not, which only matters to
  a later share on that port and is Tailscale's behavior, not Tailtray's.
- **Operator**: the LocalAPI answers a non-operator write with 403 `serve config denied`; check
  that the CLI prints it as `Access denied: …`, so TRY's operator error matches. If it does not, the
  fake's failure text and the Errors rule are an outbox entry.
- **Row**: a `PopupBaseMenuItem` with an `St.Button` for the stop button. The item reacts to
  presses through its own `Clutter.ClickGesture` (`js/ui/popupMenu.js` of GNOME Shell 49), so a
  press on the button must neither reach the item's `activate`, which would copy and close the
  menu, nor be swallowed by the gesture; only the pointer test of the acceptance proves it. If the
  button alone does not, the fallback is that the item's `activate(event)` returns early for an
  event whose source is the button or inside its allocation, and the button runs the stop.
- **GNOME Shell 50**: `metadata.json` lists 49 and 50, but the acceptance runs on the 49 of the
  development machine; the rules about the click gesture and stylesheet loading are verified on 49
  and expected to hold on 50.
- **Width**: the share row's text column has `width: 22em` in the stylesheets, and its labels
  ellipsize; `max-width` alone would not do, since `St.ThemeNode.adjust_preferred_width()` only
  clamps the natural width, which still follows the text up to the cap.
- **Styles**: the tiles, captions, and colors are style classes in two new stylesheets,
  `src/stylesheet-dark.css` and `src/stylesheet-light.css`, not inline styles. GNOME Shell 49
  loads the first of `stylesheet-<variant>.css` and `stylesheet.css` that exists, the variant
  being `Main.getStyleVariant()`, and reloads it when the color scheme changes
  (`js/ui/extensionSystem.js`, `_loadExtensionStylesheet`); only one is loaded, so each file is
  complete. `gnome-extensions pack` takes both variant stylesheets on its own
  (`extensions-tool/src/command-pack.c`), so the Makefile needs no change; the acceptance checks
  the zip. The accent color is
  `-st-accent-color` (GNOME 47 and later).
- **Two-line rows**: TRY's Account submenu already shows two-line profile rows; reuse that
  vertical `St.BoxLayout` of two `St.Label`s, with `ellipsize` set on the second one's
  `clutter_text`.
- **Public repository hygiene**: fixtures and screenshots use the fictional
  `workstation.tail1234.ts.net`, never a real tailnet.
