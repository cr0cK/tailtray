---
code: SRV
status: draft
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
gains the Shared section between This device and the controls, and stopping a share joins the
actions of TRY's Actions. Nothing outside the menu changes: the panel icon and the notifications
stay as TRY defines them.

The mockup, [`mockups/SRV.html`](mockups/SRV.html), shows every state of the Shared section; open
it in a browser. Where it and the rules disagree, the rules win.

## Reading the shares

- A refresh whose `tailscale status --json` answers Connected, and that still counts (see TRY's
  Reading the state), runs `tailscale serve status --json` after `tailscale get --json`. The calls
  run one after the other.
- It is a read: it needs no operator.
- In any other state it does not run, and the Shared section is hidden.
- When it fails, is killed by its time limit, or prints JSON Tailtray cannot read, the refresh
  still succeeds: the Shared section shows its failure line (see Shared section), and nothing else
  changes.
- An output of `null` or `{}` is a good read with no share.

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
- Every field is optional; a missing one reads as empty or false.

### URL, label, and target

| Share | URL (copied) | Label (shown) |
|---|---|---|
| Web | `<scheme>://<host>[:<port>]<path>` | the URL with `<host>` cut to its first label |
| TCP | `<host>:<port>` | `tcp://<host first label>:<port>` |

- `:<port>` is left out for `https` on 443 and `http` on 80. `<path>` is the mount, left out when
  it is `/`. Examples: `http://workstation.tail1234.ts.net:4173`,
  `https://workstation.tail1234.ts.net/docs`, label `https://workstation/docs`.
- The target is the first non-empty field of the handler, in this order: `Proxy` as it is, `Path`
  as it is, `Text` as `text`, `Redirect` as `redirect <Redirect>`. A handler with none has no
  target. A TCP share's target is its `TCPForward`.

### Order

- Background shares first, then foreground ones. Within each, by port ascending, then by mount in
  code-point order.

## Shared section

- It is its own group in TRY's Menu layout, between This device and the controls, so the menu has
  six groups. The separator rule of Menu layout applies unchanged.
- It shows in Connected only, when there is at least one share or the read failed. With a good
  read and no share, it is hidden.
- A dim caption `Shared from this device`, then one row per share, in a scrolling area at most
  280 pixels high.
- A row shows, left to right: the label; a **Public** pill when the share is public; the target,
  dim, ellipsized at its end when it does not fit; a copy icon; and the stop button when the share
  has one.
- Activating the row copies the share's URL, as TRY's Copying says.
- The stop button is an icon button with the `media-playback-stop-symbolic` icon and the
  accessible name `Stop sharing <URL>`. Activating it stops the share (see Stopping a share); it
  does not copy.
- Only a background share whose host is this device's MagicDNS name has a stop button. A
  foreground share has none: it ends with the command running in its terminal. A share of
  another host has none: the CLI only removes shares of this device's name.
- When the read failed, the caption is followed by one insensitive dim row, `Could not read what
  this device shares`, and no other row.
- A refresh while the menu is open updates the rows in place, as TRY's Reading the state says for
  the other sections.

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

- A public share stops with the same command: when its port has no handler left, Tailscale
  removes its Funnel too. Tailtray never runs `tailscale funnel`.
- While it is pending, the row's target reads `Stopping…`. The follow-up shows what the read
  returns: the row is gone when the stop worked, and back to its target otherwise.
- Stopping needs the user to be the Tailscale operator; when they are not, the error is the
  operator one of TRY's Errors.
- There is no confirmation: one activation stops the share.

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

## Plans

Each plan is one PR, delivered in order. Its delivery is stamped on the tracking issue, #16.

### SRV-P1: Shared section

**Scope**: every section of this spec.

**Temporary restrictions**: none.

**Acceptance**
- `node --test` covers a new pure module `src/serve.js`: shares from a config with a Web share on
  `http` and on `https` (443 without port, another port with it), several mounts on one port, a TCP
  share and a TLS-terminated one, a public share, a foreground share, a `Web` entry whose port has
  neither `HTTPS` nor `HTTP` (ignored), `Services` (ignored), a host other than this device's (no
  stop), each target kind and a handler with none, `null`, `{}`, and output Tailtray cannot read;
  the order; the URL and label of each kind; the stop command of each kind.
- `scripts/fake-tailscale` answers `serve status --json` from `serve.json`, and `serve ... off`
  removes the matching share from it (its port's `TCP` entry and `AllowFunnel` entry once the last
  handler goes, as Tailscale does); `serve` honors `.sleep`, `.fail`, `.stdout` and `.noeffect`
  like the other commands.
- Headless GNOME Shell with the fake (`scripts/verify.sh`): the section with a Web, a public, a
  TCP, and a foreground share, in that order; activating a row copies its URL (read back from
  `St.Clipboard`) and closes the menu; the stop button of each kind calls exactly the command of
  Stopping a share and keeps the menu open; the row shows `Stopping…` while a slow stop runs, with
  every other action row and stop button insensitive; a failing stop shows its error after the
  follow-up and the row keeps its target; a stop failing with `Access denied` shows the operator
  error; a foreground share and another host's share have no stop button; a failing
  `serve status` shows the failure line and keeps every other section; with no share the section
  and its separator are hidden; in Disconnected `serve status` is never called (fake's log).
- `npm run lint` and `make check` pass; CI is green; no `JS ERROR` or `JS WARNING` in the shell
  log.
- `scripts/screenshots.sh` adds `docs/screenshots/menu-shared.png`, the README shows it, and
  AGENTS.md's layout table lists `src/serve.js`.

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
- **Row**: a `PopupBaseMenuItem` with an `St.Button` for the stop button; the button's `clicked`
  must not reach the item's `activate`, which would copy and close the menu.
- **Public repository hygiene**: fixtures and screenshots use the fictional
  `workstation.tail1234.ts.net`, never a real tailnet.
