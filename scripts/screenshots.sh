#!/usr/bin/env bash
# Regenerates the README screenshots in docs/screenshots/. Runs the checkout in a headless GNOME
# Shell on a private D-Bus session, with scripts/fake-tailscale standing in for the Tailscale CLI,
# so the images show fictional data and never a real tailnet.
set -euo pipefail

source "$(dirname "$0")/lib/headless.sh"
for command in magick; do
    if ! command -v "$command" >/dev/null; then
        echo "Missing $command."
        exit 1
    fi
done
headless_reexec "$@"
OUT=$HL_ROOT/docs/screenshots
mkdir -p "$OUT"
headless_boot

# Captures the whole screen with the menu open, with the submenu named by $2 (an extension
# property such as _accountMenu) expanded when given, then $3 (JavaScript) run and $4 (a
# JavaScript condition) waited for when given, and widens MENU_LEFT and MENU_BOTTOM, the edges
# that crop_menus later applies to every menu capture.
MENU_LEFT=999999
MENU_BOTTOM=0
capture_menu() {
    local area left bottom
    pointer_park
    menu_open
    if [[ -n ${2:-} ]]; then
        # One submenu is open at a time. The account list is requested when the menu opens.
        wait_model "!m.accounts.loading"
        shell_eval "$HL_EXT.$2.menu.open(false); 'ok'" >/dev/null
        sleep 1
    fi
    if [[ -n ${3:-} ]]; then
        shell_eval "$3" >/dev/null
        wait_for "${4:-true}" 10
        pointer_park
        sleep 0.5
    fi
    area=$(shell_eval "const a = $HL_EXT._indicator.menu.actor;
        const [x, y] = a.get_transformed_position(); const [, h] = a.get_transformed_size();
        [Math.max(0, Math.floor(x) - 24), Math.min(global.stage.height, Math.ceil(y + h) + 24)].join(' ')")
    read -r left bottom <<<"$area"
    ((left < MENU_LEFT)) && MENU_LEFT=$left
    ((bottom > MENU_BOTTOM)) && MENU_BOTTOM=$bottom
    screenshot "$OUT/$1"
    menu_close
}

# The README shows the menu captures side by side, so they share one size: the panel strip from
# the leftmost menu edge to the screen edge, down to the lowest menu bottom.
crop_menus() {
    local image
    for image in "$@"; do
        magick "$OUT/$image" -crop "+${MENU_LEFT}+0" -crop "x${MENU_BOTTOM}+0+0" +repage "$OUT/$image"
    done
}

show() {
    fake_state "$1"
    shell_eval "$HL_EXT._engine.requestRefresh()" >/dev/null
    wait_model "m.state.id === '$2' && m.loaded"
}

wait_model "m.loaded"
capture_menu menu-connected.png
show stopped disconnected
capture_menu menu-disconnected.png
show needs-login login
capture_menu menu-login-required.png
show running connected
capture_menu menu-account.png _accountMenu
capture_menu menu-settings.png _settingsMenu
# An exit node in use that is offline, next to an online and an offline one.
fake_state exit-node
shell_eval "$HL_EXT._engine.requestRefresh()" >/dev/null
wait_model "m.status.Peer['nodekey:eeee'] !== undefined"
capture_menu menu-exit-node.png _exitMenu
# The other devices (last seen times are relative to now), then one expanded with a ping result.
fake_state running
fake_devices
fake_pong 1 home-router 192.0.2.10:41641 4ms
shell_eval "$HL_EXT._engine.requestRefresh()" >/dev/null
wait_model "m.status.Peer['nodekey:nDEV1'] !== undefined"
capture_menu menu-devices.png
DEVICE="$HL_EXT._deviceEntries.get('nDEV1')"
capture_menu menu-devices-ping.png "" "$DEVICE.row.activate(null); $DEVICE.ping.activate(null); 'ok'" \
    "$DEVICE.ping.resultLabel.text === 'direct · 4 ms'"
# What this device shares: a public Web share, a Web share, a TCP share, and one started in a
# terminal, with the two default peers.
fake_state running
fake_serve
shell_eval "$HL_EXT._engine.requestRefresh()" >/dev/null
wait_model "m.shares !== null && m.shares.ok && m.shares.shares.length === 4"
capture_menu menu-shared.png
crop_menus menu-connected.png menu-disconnected.png menu-login-required.png menu-account.png \
    menu-settings.png menu-exit-node.png menu-devices.png menu-devices-ping.png menu-shared.png

# Drop metadata such as creation time so unchanged screenshots stay byte-identical.
for image in "$OUT"/*.png; do
    magick "$image" -strip "$image"
done
assert_log_clean || echo "The shell logged JavaScript errors; check the screenshots."
echo "Screenshots written to $OUT"
