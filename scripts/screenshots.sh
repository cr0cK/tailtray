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

# Captures the whole screen with the menu open, and widens MENU_LEFT and MENU_BOTTOM, the edges
# that crop_menus later applies to every menu capture.
MENU_LEFT=999999
MENU_BOTTOM=0
capture_menu() {
    local area left bottom
    pointer_park
    menu_open
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
crop_menus menu-connected.png menu-disconnected.png menu-login-required.png

# Drop metadata such as creation time so unchanged screenshots stay byte-identical.
for image in "$OUT"/*.png; do
    magick "$image" -strip "$image"
done
assert_log_clean || echo "The shell logged JavaScript errors; check the screenshots."
echo "Screenshots written to $OUT"
