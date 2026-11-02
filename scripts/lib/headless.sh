#!/usr/bin/env bash
# Shared by scripts/screenshots.sh and scripts/verify.sh: runs the checkout in a headless GNOME
# Shell on a private D-Bus session, with scripts/fake-tailscale first on PATH, and drives it
# through org.gnome.Shell.Eval and org.gnome.Shell.Screenshot. Nothing here touches the real
# settings, the real tailnet, or the running desktop session.
#
# Usage, at the top of a script:
#   source "$(dirname "$0")/lib/headless.sh"
#   headless_reexec "$@"      # packs, then re-runs the script inside dbus-run-session
#   headless_boot             # starts the shell with the extension enabled
# and everything below this line in the script runs inside the session.

HL_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HL_UUID=tailtray@cr0ck.github.io
HL_SCHEMA=org.gnome.shell.extensions.tailtray
HL_SHELL_PID=
# The extension instance, as a JavaScript expression for shell_eval.
HL_EXT="Main.extensionManager.lookup('$HL_UUID').stateObj"
# Eval has Main, Gio, GLib, and global, but not St or Clutter.
HL_PRELUDE="const St = imports.gi.St; const Clutter = imports.gi.Clutter;"

headless_reexec() {
    [[ ${HL_INSIDE:-} == 1 ]] && return 0
    local command
    for command in gnome-shell dbus-run-session gdbus glib-compile-schemas unzip python3; do
        if ! command -v "$command" >/dev/null; then
            echo "Missing $command."
            exit 1
        fi
    done
    make -C "$HL_ROOT" pack >/dev/null || { make -C "$HL_ROOT" pack; exit 1; }

    # Exported before the bus starts: services it activates, such as the preferences window,
    # inherit its environment, so they too stay away from the real settings and tailnet.
    WORK=$(mktemp -d)
    export WORK HL_INSIDE=1 XDG_DATA_HOME=$WORK/data XDG_CONFIG_HOME=$WORK/config
    export XDG_CACHE_HOME=$WORK/cache
    export GSETTINGS_BACKEND=keyfile GTK_A11Y=none
    export GSETTINGS_SCHEMA_DIR=$XDG_DATA_HOME/gnome-shell/extensions/$HL_UUID/schemas
    # The display name stays short: the Wayland socket path must fit in 108 bytes.
    export WAYLAND_DISPLAY=tailtray-hl
    # The fake tailscale comes first on PATH, so no run reaches the real tailnet.
    export TAILTRAY_FAKE_DIR=$WORK/fake
    mkdir -p "$WORK/bin" "$TAILTRAY_FAKE_DIR"
    ln -s "$HL_ROOT/scripts/fake-tailscale" "$WORK/bin/tailscale"
    export PATH=$WORK/bin:$PATH
    exec dbus-run-session -- "$0" "$@"
}

headless_cleanup() {
    if [[ -n $HL_SHELL_PID ]]; then
        kill "$HL_SHELL_PID" 2>/dev/null && wait "$HL_SHELL_PID" 2>/dev/null
    fi
    rm -rf "$WORK"
}

# Puts the fixtures in the fake's directory: the state is Running, nothing sleeps or fails, and
# the call log is empty. A scenario then changes what it needs with fake_state, fake_set and the
# KEY.sleep and KEY.fail files described in scripts/fake-tailscale.
fake_reset() {
    rm -f "$TAILTRAY_FAKE_DIR"/*
    cp "$HL_ROOT/tests/fixtures/status-running.json" "$TAILTRAY_FAKE_DIR/status.json"
    cp "$HL_ROOT/tests/fixtures/get.json" "$TAILTRAY_FAKE_DIR/get.json"
    cp "$HL_ROOT/tests/fixtures/switch-list.json" "$TAILTRAY_FAKE_DIR/switch.json"
    : >"$TAILTRAY_FAKE_DIR/calls.log"
}

# fake_state running|stopped|connecting|needs-login|needs-approval
fake_state() {
    cp "$HL_ROOT/tests/fixtures/status-$1.json" "$TAILTRAY_FAKE_DIR/status.json"
}

# fake_set KEY.sleep 3: writes a control file of the fake.
fake_set() {
    printf '%s\n' "$2" >"$TAILTRAY_FAKE_DIR/$1"
}

fake_unset() {
    rm -f "$TAILTRAY_FAKE_DIR/$1"
}

# The commands the fake received, one line per call: "<key> <args>".
fake_calls() {
    python3 -c '
import json, sys
for line in open(sys.argv[1]):
    call = json.loads(line)
    print(call["key"], " ".join(call["args"]))
' "$TAILTRAY_FAKE_DIR/calls.log"
}

# The number of calls with a given key, such as status or switch-list.
fake_count() {
    fake_calls | awk -v key="$1" '$1 == key' | wc -l
}

headless_boot() {
    trap headless_cleanup EXIT
    local extensions=$XDG_DATA_HOME/gnome-shell/extensions
    mkdir -p "$extensions/$HL_UUID" "$extensions/unsafe@tailtray"
    unzip -q "$HL_ROOT/dist/$HL_UUID.shell-extension.zip" -d "$extensions/$HL_UUID"
    glib-compile-schemas "$GSETTINGS_SCHEMA_DIR"
    fake_reset

    # Eval and Screenshot refuse callers outside unsafe mode; this throwaway extension enables it.
    cat >"$extensions/unsafe@tailtray/metadata.json" <<'JSON'
{"uuid": "unsafe@tailtray", "name": "Unsafe mode", "description": "Headless runs only",
 "shell-version": ["49"]}
JSON
    cat >"$extensions/unsafe@tailtray/extension.js" <<'JS'
export default class {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
JS

    gsettings set org.gnome.shell enabled-extensions "['$HL_UUID', 'unsafe@tailtray']"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "'999'"
    gsettings set org.gnome.desktop.interface color-scheme "'prefer-dark'"

    shell_start
}

shell_start() {
    gnome-shell --headless --wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY" \
        --virtual-monitor 1280x800 >>"$WORK/shell.log" 2>&1 &
    HL_SHELL_PID=$!
    wait_for "Main.extensionManager.lookup('$HL_UUID')?.state === 1"
    wait_for "Main.layoutManager._startingUp === false"
    pointer_create
    # The unsafe-mode helper makes the Shell announce it; keep that banner out of screenshots.
    shell_eval "Main.messageTray.getSources().forEach(source => source.destroy()); 'ok'" >/dev/null
    wait_for "!Main.messageTray._banner"
}

# Creates the virtual pointer, and moves it twice: the first motion of a new device lands at an
# edge of the screen. Doing it before any menu opens matters, since a device that appears while
# a menu is open closes it.
pointer_create() {
    shell_eval "globalThis.__pointer = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE); 'ok'" >/dev/null
    local _
    for _ in 1 2; do
        shell_eval "globalThis.__pointer.notify_absolute_motion(GLib.get_monotonic_time(), 640, 400); 'ok'" >/dev/null
        sleep 0.3
    done
}

# Stops the shell and starts it again on the same settings, as a GNOME Shell restart does.
shell_restart() {
    kill "$HL_SHELL_PID" 2>/dev/null
    wait "$HL_SHELL_PID" 2>/dev/null || true
    HL_SHELL_PID=
    shell_start
}

# Runs JavaScript in the shell and prints its result. Strings come back without their quotes.
shell_eval() {
    local reply
    reply=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$HL_PRELUDE $1" 2>/dev/null) || return 1
    [[ $reply == "(true, "* ]] || return 1
    reply=${reply#(true, \'}
    reply=${reply%\')}
    reply=${reply//\\\'/\'}
    reply=${reply#\"}
    printf '%s\n' "${reply%\"}"
}

# Polls a JavaScript condition until it reads true, for up to $2 seconds (20 by default).
wait_for() {
    for _ in $(seq $((${2:-20} * 5))); do
        [[ $(shell_eval "$1" || true) == true ]] && return 0
        sleep 0.2
    done
    echo "Timed out waiting for: $1"
    tail -20 "$WORK/shell.log"
    return 1
}

# Disables then enables the extension, so it starts a new instance on the current settings.
ext_reload() {
    shell_eval "Main.extensionManager.disableExtension('$HL_UUID')" >/dev/null
    shell_eval "Main.extensionManager.enableExtension('$HL_UUID')" >/dev/null
    wait_for "Main.extensionManager.lookup('$HL_UUID')?.state === 1"
}

menu_open() {
    shell_eval "$HL_EXT._indicator.menu.open()" >/dev/null
    wait_for "$HL_EXT._indicator.menu.isOpen && !$HL_EXT._indicator.menu.actor.get_transition('opacity')"
    sleep 0.3
}

menu_close() {
    shell_eval "$HL_EXT._indicator.menu.close()" >/dev/null
    wait_for "!$HL_EXT._indicator.menu.isOpen"
}

# Waits until the extension's model satisfies a JavaScript condition on `m`.
wait_model() {
    wait_for "(m => $1)($HL_EXT._engine.model)" "${2:-20}"
}

# Captures the whole screen into $1.
screenshot() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$1" >/dev/null
}

# Captures the panel strip and the open menu into $1: from the menu's left edge, less a margin,
# to the screen's right edge, and down to the menu's bottom edge, plus a margin.
menu_shot() {
    local area left bottom width
    area=$(shell_eval "const a = $HL_EXT._indicator.menu.actor;
        const [x, y] = a.get_transformed_position(); const [, h] = a.get_transformed_size();
        [Math.max(0, Math.floor(x) - 24), Math.min(global.stage.height, Math.ceil(y + h) + 24),
         global.stage.width].join(' ')")
    read -r left bottom width <<<"$area"
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.ScreenshotArea "$left" 0 $((width - left)) "$bottom" false \
        "$1" >/dev/null
}

# Captures the panel icon into $1: a strip at the top right of the screen.
panel_shot() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.ScreenshotArea 960 0 320 36 false "$1" >/dev/null
}

# Fails when the shell logged a JavaScript error or warning.
assert_log_clean() {
    if grep -E 'JS (ERROR|WARNING)' "$WORK/shell.log"; then
        echo "The shell logged JavaScript errors."
        return 1
    fi
}

# Moves a real pointer to a point and clicks. The motion is its own step: a click sent with it
# lands on the old position.
pointer_click_at() {
    shell_eval "globalThis.__pointer.notify_absolute_motion(GLib.get_monotonic_time(), $1, $2); 'moved'" \
        >/dev/null
    sleep 0.4
    shell_eval "(() => {
        const t = GLib.get_monotonic_time();
        globalThis.__pointer.notify_button(t, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        globalThis.__pointer.notify_button(t + 2000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        return 'clicked';
    })()" >/dev/null
    sleep 0.3
}

# Clicks the centre of an actor, given as a JavaScript expression.
pointer_click() {
    local centre
    centre=$(shell_eval "(() => {
        const [x, y] = ($1).get_transformed_position();
        const [w, h] = ($1).get_transformed_size();
        return [x + w / 2, y + h / 2].join(' ');
    })()")
    pointer_click_at $centre
}

# Moves the pointer away from the menu, so no row shows a hover highlight in a screenshot.
pointer_park() {
    shell_eval "globalThis.__pointer.notify_absolute_motion(GLib.get_monotonic_time(), 40, 400); 'ok'" \
        >/dev/null
    sleep 0.3
}

# The text of every visible label of the menu, in order, separated by |.
menu_texts() {
    shell_eval "(() => {
        const out = [];
        const walk = actor => {
            if (!actor.visible)
                return;
            if (actor instanceof St.Label)
                out.push(actor.text);
            actor.get_children().forEach(walk);
        };
        walk($HL_EXT._indicator.menu.box);
        return out.join('|');
    })()"
}

# The clipboard text, read back through St.Clipboard.
clipboard_text() {
    shell_eval "St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD,
        (_clipboard, text) => { globalThis.__clip = text; }); 'requested'" >/dev/null
    sleep 0.4
    shell_eval "globalThis.__clip"
}

# The result of a scenario, as one line, and how many failed.
HL_FAILURES=0
check() {
    local description=$1
    shift
    if "$@"; then
        echo "PASS  $description"
    else
        echo "FAIL  $description"
        HL_FAILURES=$((HL_FAILURES + 1))
    fi
}
