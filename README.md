# Tailtray

[![PR checks](https://github.com/cr0cK/tailtray/actions/workflows/pr-checks.yml/badge.svg)](https://github.com/cr0cK/tailtray/actions/workflows/pr-checks.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small GNOME Shell extension that shows and controls your local Tailscale node from the top bar. It
calls the `tailscale` command line, stores no credential, and never elevates privileges.

<p align="center">
  <img src="docs/screenshots/menu-connected.png" alt="Tailtray menu when connected: a switch, the tailnet and login name, and this device's name and addresses" width="32%">
  <img src="docs/screenshots/menu-disconnected.png" alt="Tailtray menu when disconnected" width="32%">
  <img src="docs/screenshots/menu-login-required.png" alt="Tailtray menu when a login is required, with the command to copy" width="32%">
</p>

## Features

- A panel icon that shows the connection state: connected, connecting or disconnected, login or
  approval required, or unavailable.
- A switch in the menu to connect (`tailscale up`) and disconnect (`tailscale down`).
- The tailnet and login name, warnings from Tailscale (including a key about to expire), and this
  device's MagicDNS name and Tailscale addresses, each one click away from your clipboard.
- Clear explanations when Tailscale is not installed, not running, or you are not the operator,
  with the command to fix it ready to copy.
- A preferences window with the refresh interval.

Accounts, exit nodes, settings, other devices, and notifications are coming in the next releases;
see [`docs/specs/TRY.md`](docs/specs/TRY.md).

## Requirements

- GNOME Shell 49 on Linux.
- `tailscale` and `tailscaled`, version 1.104 or later.
- To connect and disconnect from the menu, your user must be the Tailscale operator. Run once:

  ~~~sh
  sudo tailscale set --operator=$USER
  ~~~

## Install

Download `tailtray@cr0ck.github.io.shell-extension.zip` from the
[latest release](https://github.com/cr0cK/tailtray/releases/latest), then:

~~~sh
gnome-extensions install --force tailtray@cr0ck.github.io.shell-extension.zip
gnome-extensions enable tailtray@cr0ck.github.io
~~~

Log out and back in if GNOME Shell does not list the extension yet.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `make check` and `npm run lint` run the checks, and
`scripts/sandbox.sh --fake` tries the extension in a windowed GNOME Shell without touching your
tailnet.

## License

[MIT](LICENSE)
