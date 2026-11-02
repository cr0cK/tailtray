#!/usr/bin/env bash
# Runs the current checkout in a windowed GNOME Shell (mutter devkit), isolated from the
# desktop session: extensions and GSettings live under the sandbox directory, on a private
# D-Bus session. Preferences persist between runs; pass --reset to start from scratch.
# Pass --fake to put scripts/fake-tailscale first on PATH, so the sandbox never reaches your
# tailnet; its replies live in $SANDBOX/fake (see the header of scripts/fake-tailscale).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=tailtray@cr0ck.github.io
SANDBOX=${TAILTRAY_SANDBOX:-${XDG_CACHE_HOME:-$HOME/.cache}/tailtray-sandbox}
EXTENSION_DIR=$SANDBOX/data/gnome-shell/extensions/$UUID
RESET=0
FAKE=0

for argument in "$@"; do
    case $argument in
    --reset) RESET=1 ;;
    --fake) FAKE=1 ;;
    *)
        echo "Usage: $0 [--reset] [--fake]" >&2
        exit 2
        ;;
    esac
done
((RESET)) && rm -rf "$SANDBOX"

for command in gnome-shell dbus-run-session glib-compile-schemas unzip; do
    if ! command -v "$command" >/dev/null; then
        echo "Missing $command." >&2
        exit 1
    fi
done
if [[ ! -x /usr/libexec/mutter-devkit ]]; then
    echo "Missing mutter devkit; install mutter-devel." >&2
    exit 1
fi

make -C "$ROOT" pack
rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR" "$SANDBOX/config"
unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXTENSION_DIR"
glib-compile-schemas "$EXTENSION_DIR/schemas"

sandbox_gsettings() {
    XDG_CONFIG_HOME="$SANDBOX/config" GSETTINGS_BACKEND=keyfile gsettings set "$@"
}
# Set on every run, so a sandbox created before a UUID change still enables this checkout.
sandbox_gsettings org.gnome.shell enabled-extensions "['$UUID']"
sandbox_gsettings org.gnome.shell disable-user-extensions false
sandbox_gsettings org.gnome.shell welcome-dialog-last-shown-version "'999'"

SANDBOX_PATH=$PATH
if ((FAKE)); then
    FAKE_DIR=$SANDBOX/fake
    mkdir -p "$FAKE_DIR" "$SANDBOX/bin"
    ln -sf "$ROOT/scripts/fake-tailscale" "$SANDBOX/bin/tailscale"
    for fixture in status:status-running get:get switch:switch-list; do
        [[ -e $FAKE_DIR/${fixture%%:*}.json ]] ||
            cp "$ROOT/tests/fixtures/${fixture##*:}.json" "$FAKE_DIR/${fixture%%:*}.json"
    done
    SANDBOX_PATH=$SANDBOX/bin:$PATH
    export TAILTRAY_FAKE_DIR=$FAKE_DIR
    echo "Fake tailscale: replies in $FAKE_DIR"
fi

echo "Sandbox: $SANDBOX"
exec env \
    XDG_DATA_HOME="$SANDBOX/data" \
    XDG_CONFIG_HOME="$SANDBOX/config" \
    GSETTINGS_BACKEND=keyfile \
    PATH="$SANDBOX_PATH" \
    dbus-run-session -- gnome-shell --devkit --wayland
