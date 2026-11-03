#!/usr/bin/env bash
# Verifies the extension in a headless GNOME Shell against scripts/fake-tailscale: every scenario
# of the acceptance criteria that needs a running shell. Prints PASS or FAIL per check, writes
# the screenshots to $VERIFY_SHOTS (dist/verify-shots by default), and exits 1 on any failure.
# The shell's stderr is noisy (D-Bus activations); run it as `scripts/verify.sh 2>/dev/null`.
set -uo pipefail

source "$(dirname "$0")/lib/headless.sh"
headless_reexec "$@"
SHOTS=${VERIFY_SHOTS:-$HL_ROOT/dist/verify-shots}
mkdir -p "$SHOTS"
headless_boot

PATH_WITH_FAKE=$PATH
MODEL="$HL_EXT._engine.model"

# A fresh scenario: fixtures reset, a long refresh interval, notifications off (unless
# NOTIFICATIONS=true) with none remembered, no time limit override, a new extension instance, and
# its first refresh answered.
begin() {
    echo
    echo "== $1"
    fake_reset
    set_interval "${2:-60}"
    gsettings set "$HL_SCHEMA" notifications "${NOTIFICATIONS:-false}"
    gsettings reset "$HL_SCHEMA" notified-key-expiries
    shell_eval "GLib.setenv('PATH', '$PATH_WITH_FAKE', true);
        GLib.unsetenv('TAILTRAY_TIMEOUT_SECONDS'); 'ok'" >/dev/null
    ext_reload
    wait_model "m.loaded"
}

set_interval() {
    gsettings set "$HL_SCHEMA" refresh-interval "$1"
}

refresh_now() {
    shell_eval "$HL_EXT._engine.requestRefresh()" >/dev/null
}

model() {
    shell_eval "$MODEL.$1"
}

# Shows a state of the fake and waits for the model to reach it.
show() {
    fake_state "$1"
    refresh_now
    wait_model "m.state.id === '$2' && m.loaded"
}

# Menu and panel screenshots of the current state.
shoot() {
    menu_close
    panel_shot "$SHOTS/panel-$1.png"
    menu_open
    menu_shot "$SHOTS/menu-$1.png"
    menu_close
}

pids_of_fake() {
    pgrep -f "$WORK/bin/tailscale" | wc -l
}

pending_label() {
    shell_eval "$HL_EXT._header.stateLabel.text"
}

# --- States, screenshots of the menu and of the panel icon in each ----------------------------
begin "Connection states"
check "Connected" test "$(model state.label)" = Connected
shoot connected
show stopped disconnected
shoot disconnected
show connecting connecting
shoot connecting
show needs-login login
shoot login-required
show needs-approval approval
shoot approval-required
show running connected

fake_set status.fail 1
fake_set status.stderr "failed to connect to local tailscaled; it doesn't appear to be running"
refresh_now
wait_model "m.state.id === 'unavailable'"
shoot unavailable-service-down
check "service down" test "$(model refreshError.text)" = "The Tailscale service is not running."
fake_set status.stderr "Access denied: status access denied"
refresh_now
wait_model "m.refreshError.text.includes('operator')"
shoot unavailable-access-denied
fake_unset status.fail
fake_unset status.stderr
# The CLI is looked up on PATH when the extension is enabled.
shell_eval "GLib.setenv('PATH', '/nonexistent', true); 'ok'" >/dev/null
ext_reload
wait_model "m.refreshError.text.includes('not installed')"
shoot unavailable-cli-missing
check "CLI missing" test "$(model refreshError.text)" = "The Tailscale CLI is not installed."
shell_eval "GLib.setenv('PATH', '$PATH_WITH_FAKE', true); 'ok'" >/dev/null
# A slow fake stays visible as a process for the whole check, so a spawn cannot go unnoticed.
fake_set status.sleep 5
calls_before=$(fake_count status)
refresh_now
sleep 1
check "a CLI that appears on PATH later is not found until the extension is enabled again" \
    test "$(model refreshError.text)" = "The Tailscale CLI is not installed."
check "no command was started in the meantime" \
    test "$(pids_of_fake)$(fake_count status)" = "0$calls_before"
fake_unset status.sleep
ext_reload
wait_model "m.loaded"
check "found once enabled again" test "$(model state.id)" = connected
fake_set status.stdout "<html>not json</html>"
refresh_now
wait_model "m.refreshError.text.includes('cannot read')"
shoot unavailable-unreadable
check "unreadable status" test "$(model refreshError.text)" = "Tailscale returned a status Tailtray cannot read."
fake_unset status.stdout
show running connected
check "recovers from Unavailable" test "$(model state.id)" = connected

# --- Warnings ---------------------------------------------------------------------------------
begin "Warnings"
python3 - "$TAILTRAY_FAKE_DIR/status.json" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
d['Health'] = ['Tailscale is stopped.', 'SELinux is enabled; Tailscale SSH may not work.']
open(path, 'w').write(json.dumps(d))
PY
refresh_now
wait_model "m.status.Health.length === 2"
menu_open
check "one warning shows under the identity, the stopped entry removed" \
    test "$(menu_texts | grep -c 'SELinux is enabled')" = 1
check "no Warnings submenu for one warning" test "$(menu_texts | grep -c 'Warnings (')" = 0
menu_shot "$SHOTS/menu-warning-one.png"
python3 - "$TAILTRAY_FAKE_DIR/status.json" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
d['Self']['KeyExpiry'] = '2000-01-01T00:00:00Z'
open(path, 'w').write(json.dumps(d))
PY
refresh_now
wait_model "m.status.Self.KeyExpiry === '2000-01-01T00:00:00Z'"
check "two warnings fold into Warnings (2)" test "$(menu_texts | grep -c 'Warnings (2)')" = 1
shell_eval "$HL_EXT._warningsMenu.menu.open(false)" >/dev/null
sleep 0.6
menu_shot "$SHOTS/menu-warnings-open.png"
refresh_now
wait_model "m.status.Health.length === 2"
sleep 0.3
check "a refresh keeps the Warnings submenu open" test "$(shell_eval "$HL_EXT._warningsMenu.menu.isOpen")" = true
menu_close

# --- Header switch driven with a real pointer; copy -------------------------------------------
begin "Header switch and copy"
fake_state stopped
refresh_now
wait_model "m.state.id === 'disconnected'"
menu_open
check "the switch is off in Disconnected" test "$(shell_eval "$HL_EXT._header.state")" = false
pointer_click "$HL_EXT._header._switch"
wait_model "m.state.id === 'connected' && m.pending === null"
check "clicking the switch ran up" test "$(fake_calls | awk '$1=="up"||$1=="down"' | tr '\n' ',')" = "up up,"
check "the menu stays open after the toggle" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
pointer_click "$HL_EXT._header.label"
wait_model "m.state.id === 'disconnected' && m.pending === null"
check "clicking the row ran down" test "$(fake_calls | awk '$1=="up"||$1=="down"' | tr '\n' ',')" = "up up,down down,"
check "the menu stays open after the second toggle" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
check "no refresh ran a command" \
    test "$(fake_calls | awk '$1!="status"&&$1!="get"&&$1!="switch-list"' | wc -l)" = 2
check "tailscale login was never called" test "$(fake_calls | awk '$1=="unknown"' | wc -l)" = 0

refresh_now
fake_state running
refresh_now
wait_model "m.state.id === 'connected'"
check "a refresh that flips the switch calls no command" \
    test "$(fake_calls | awk '$1=="up"||$1=="down"' | wc -l)" = 2
menu_close
menu_open
pointer_click "$HL_EXT._deviceItems.ipv4"
sleep 0.5
check "copying puts the address in the clipboard" test "$(clipboard_text)" = 100.64.0.1
check "copying closes the menu" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = false
check "copying shows the OSD" test "$(shell_eval "Main.osdWindowManager._osdWindows.some(w => w.visible)")" = true
screenshot "$SHOTS/osd-copied.png"
check "copying runs no command" \
    test "$(fake_calls | awk '$1!="status"&&$1!="get"&&$1!="switch-list"&&$1!="up"&&$1!="down"' | wc -l)" = 0
sleep 2

# --- Actions ----------------------------------------------------------------------------------
begin "A failing down shows its error once the follow-up answered"
fake_set down.fail 1
fake_set down.stderr "Access denied: prefs write access denied"
fake_set down.noeffect 1
menu_open
fake_set status.sleep 2
shell_eval "$HL_EXT._header.activate(null)" >/dev/null
sleep 0.8
check "label reads Disconnecting… while it runs" test "$(pending_label)" = "Disconnecting…"
check "the panel icon's accessible name follows it" \
    test "$(shell_eval "$HL_EXT._indicator.accessible_name")" = "Tailscale: Disconnecting…"
check "the switch is insensitive while it runs" test "$(shell_eval "$HL_EXT._header.reactive")" = false
check "no error before the follow-up answered" test "$(model actionError)" = null
wait_model "m.pending === null" 10
check "the error appears once it answered" \
    test "$(model actionError.text)" = "Tailtray needs you to be the Tailscale operator."
check "the switch shows the state the follow-up read" test "$(shell_eval "$HL_EXT._header.state")" = true
sleep 0.8
menu_shot "$SHOTS/menu-action-denied.png"
check "the command to copy is shown" test "$(menu_texts | grep -c 'sudo tailscale set --operator=')" = 1
menu_close
menu_open
check "a later opening shows no error" test "$(menu_texts | grep -c 'operator')" = 0
menu_close

begin "Closing the menu while a failing command runs drops its error"
fake_set down.fail 1
fake_set down.stderr "Access denied: prefs write access denied"
fake_set down.sleep 2
menu_open
shell_eval "$HL_EXT._header.activate(null)" >/dev/null
sleep 0.5
menu_close
wait_model "m.pending === null" 10
check "no error after the follow-up answered" test "$(model actionError)" = null
menu_open
check "a later opening shows no error" test "$(menu_texts | grep -c 'operator')" = 0
menu_close

begin "Colours follow the light theme"
gsettings set org.gnome.desktop.interface color-scheme "'prefer-light'"
sleep 1
show needs-login login
check "the warning colour is the light one" test "$(shell_eval "$HL_EXT._palette.warning")" = "#9c6e03"
shoot light-login-required
gsettings set org.gnome.desktop.interface color-scheme "'prefer-dark'"
sleep 1
check "and the dark one again" test "$(shell_eval "$HL_EXT._palette.warning")" = "#f6d32d"

begin "up past its time limit while status answers Login required leaves no error"
fake_state stopped
refresh_now
wait_model "m.state.id === 'disconnected'"
shell_eval "GLib.setenv('TAILTRAY_TIMEOUT_SECONDS', '2', true); 'ok'" >/dev/null
ext_reload
wait_model "m.loaded"
fake_set up.sleep 60
menu_open
shell_eval "$HL_EXT._header.activate(null)" >/dev/null
fake_state needs-login
wait_model "m.state.id === 'login'" 15
check "the menu shows Login required" test "$(model state.label)" = "Login required"
check "no error block" test "$(model actionError)" = null
check "the login command is offered" test "$(menu_texts | grep -c '^Log in from a terminal:\||tailscale up|')" -ge 1
check "no tailscale child left" test "$(pids_of_fake)" = 0
menu_close

begin "Login required shows only its command, warnings and footer, with and without AuthURL"
for variant in with without; do
    fake_state needs-login
    if [[ $variant == without ]]; then
        python3 - "$TAILTRAY_FAKE_DIR/status.json" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
d['AuthURL'] = ''
open(path, 'w').write(json.dumps(d))
PY
    fi
    refresh_now
    wait_model "m.state.id === 'login'"
    menu_open
    check "Login required ($variant AuthURL) menu content" test "$(menu_texts)" = \
        "Tailscale|Login required|Log in from a terminal:|tailscale up|You are logged out. The last login error was: node key expired|Refresh now|updated just now|Preferences"
    menu_close
done
check "tailscale login was never called" test "$(fake_calls | awk '$1=="unknown"' | wc -l)" = 0

begin "Approval required shows its line and the admin console row"
show needs-approval approval
menu_open
check "Approval required menu content" test "$(menu_texts)" = \
    "Tailscale|Waiting for approval|An admin must approve this device.|Open admin console|Refresh now|updated just now|Preferences"
shell_eval "Gio.AppInfo.launch_default_for_uri = url => { globalThis.__opened = url; return true; }; 'ok'" >/dev/null
pointer_click "$HL_EXT._approvalHelp._getMenuItems()[1]"
check "Open admin console opens the admin console" \
    test "$(shell_eval "globalThis.__opened")" = "https://login.tailscale.com/admin/machines"
shell_eval "globalThis.__opened = null; $HL_EXT._openUrl('http://example.org'); globalThis.__opened" >/dev/null
check "a URL that is not https is not opened" test "$(shell_eval "globalThis.__opened")" = null
menu_close

begin "Install Tailscale opens the download page"
shell_eval "Gio.AppInfo.launch_default_for_uri = url => { globalThis.__opened = url; return true; };
    GLib.setenv('PATH', '/nonexistent', true); 'ok'" >/dev/null
ext_reload
wait_model "m.state.id === 'unavailable'"
menu_open
pointer_click "$HL_EXT._errorSection._getMenuItems()[1]"
check "the Install Tailscale row opens the download page" \
    test "$(shell_eval "globalThis.__opened")" = "https://tailscale.com/download/linux"
menu_open
shell_eval "Gio.AppInfo.launch_default_for_uri = () => { throw new Error('no handler'); }; 'ok'" >/dev/null
pointer_click "$HL_EXT._errorSection._getMenuItems()[1]"
check "a failing launch is caught and the shell keeps working" test "$(model state.id)" = unavailable
menu_close

# --- Account and Settings ---------------------------------------------------------------------
action_calls() {
    fake_calls | awk '$1=="up"||$1=="down"||$1=="set"||$1=="switch"' | tr '\n' ','
}

# The sensitivity (reactive) and the check mark of a profile row, and the value of a switch row.
# Profile rows are keyed by their position in the answer: 1a2b is the first, 3c4d the second.
profile_item() {
    case $1 in
    1a2b) echo "$HL_EXT._accountItems.get(0)" ;;
    3c4d) echo "$HL_EXT._accountItems.get(1)" ;;
    esac
}
setting_item() { echo "$HL_EXT._settingItems['$1']"; }

open_submenu() {
    shell_eval "$HL_EXT.$1.menu.open(false); 'ok'" >/dev/null
    sleep 0.7
}

begin "Account: profiles, switching, one list per opening"
menu_open
wait_model "!m.accounts.loading"
check "the profiles were requested once for this opening" test "$(fake_count switch-list)" = 1
check "the Account row shows the current tailnet" test "$(menu_texts | grep -c 'Account|example.org')" = 1
open_submenu _accountMenu
check "both profiles are listed, the account under each tailnet" \
    test "$(menu_texts | grep -c 'example.org|alex@example.org|example.net|alex@example.net')" = 1
check "the selected profile has the check mark" \
    test "$(shell_eval "$(profile_item 1a2b).profileSelected && !$(profile_item 3c4d).profileSelected")" = true
open_submenu _settingsMenu
menu_shot "$SHOTS/menu-account-settings-open.png"
# One submenu is open at a time: opening Account again closes Settings.
open_submenu _accountMenu
menu_shot "$SHOTS/menu-account-open.png"
for _ in 1 2 3; do refresh_now; sleep 0.5; done
check "refreshes do not list the profiles" test "$(fake_count switch-list)" = 1
check "a refresh keeps the Account submenu open" test "$(shell_eval "$HL_EXT._accountMenu.menu.isOpen")" = true
# PopupMenu.Ornament: NONE is 0 and CHECK is 2.
check "the selected profile's row shows the check mark, the other none" \
    test "$(shell_eval "$(profile_item 1a2b)._ornament + '|' + $(profile_item 3c4d)._ornament")" = "2|0"
shell_eval "$(profile_item 1a2b).activate(null); 'ok'" >/dev/null
sleep 0.5
check "activating the selected profile runs nothing" test "$(action_calls)" = ""
pointer_click "$(profile_item 3c4d)"
wait_model "m.pending === null && !m.accounts.loading" 10
check "clicking another profile ran switch <id>" test "$(action_calls)" = "switch switch 3c4d,"
check "the menu stays open" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
check "the profiles were listed once more after the switch" test "$(fake_count switch-list)" = 2
check "the new profile is checked" \
    test "$(shell_eval "$(profile_item 3c4d).profileSelected && !$(profile_item 1a2b).profileSelected")" = true
check "the check mark moved to the new profile's row" \
    test "$(shell_eval "$(profile_item 1a2b)._ornament + '|' + $(profile_item 3c4d)._ornament")" = "0|2"
check "the Account submenu stayed open through the switch" \
    test "$(shell_eval "$HL_EXT._accountMenu.menu.isOpen")" = true
menu_close
menu_open
wait_model "!m.accounts.loading"
check "reopening the menu lists once more" test "$(fake_count switch-list)" = 3
check "and nothing else ran" test "$(fake_calls | awk '$1=="set"||$1=="up"||$1=="down"' | wc -l)" = 0
menu_close

begin "Account: Loading…, previous profiles while loading, Could not list accounts"
fake_set switch-list.sleep 3
menu_open
open_submenu _accountMenu
check "Loading… while the first answer sleeps" test "$(menu_texts | grep -c 'Loading…')" = 1
check "the Loading… row is insensitive" \
    test "$(shell_eval "$HL_EXT._accountMenu.menu._getMenuItems()[0].reactive")" = false
menu_shot "$SHOTS/menu-account-loading.png"
wait_model "!m.accounts.loading" 10
check "the profiles replace it" test "$(menu_texts | grep -c 'alex@example.net')" = 1
menu_close
menu_open
open_submenu _accountMenu
check "the previous profiles show while a later answer sleeps" test "$(menu_texts | grep -c 'alex@example.net')" = 1
check "they are insensitive" test "$(shell_eval "$(profile_item 3c4d).reactive")" = false
menu_shot "$SHOTS/menu-account-reloading.png"
wait_model "!m.accounts.loading" 10
check "and sensitive again once it answered" test "$(shell_eval "$(profile_item 3c4d).reactive")" = true
fake_unset switch-list.sleep
fake_set switch-list.fail 1
menu_close
menu_open
open_submenu _accountMenu
wait_model "!m.accounts.loading" 10
check "a failing list shows a single insensitive row" test "$(menu_texts | grep -c 'Could not list accounts')" = 1
check "no profile is left" test "$(menu_texts | grep -c 'alex@example.net')" = 0
check "the row is insensitive" \
    test "$(shell_eval "$HL_EXT._accountMenu.menu._getMenuItems()[0].reactive")" = false
check "the failure is not an error block" test "$(model actionError)" = null
menu_shot "$SHOTS/menu-account-failed.png"
menu_close

begin "A slow switch locks every action row and shows Switching…"
fake_set switch.sleep 3
menu_open
wait_model "!m.accounts.loading"
open_submenu _accountMenu
shell_eval "$(profile_item 3c4d).activate(null); 'ok'" >/dev/null
sleep 1
check "the chosen profile shows Switching…" test "$(shell_eval "$(profile_item 3c4d).progressLabel.text")" = "Switching…"
check "the other profile shows nothing" test "$(shell_eval "$(profile_item 1a2b).progressLabel.visible")" = false
check "the profile rows are insensitive" \
    test "$(shell_eval "!$(profile_item 1a2b).reactive && !$(profile_item 3c4d).reactive")" = true
check "the three switches are insensitive" \
    test "$(shell_eval "Object.values($HL_EXT._settingItems).every(item => !item.reactive)")" = true
check "so is the header switch" test "$(shell_eval "$HL_EXT._header.reactive")" = false
shell_eval "$(profile_item 1a2b).activate(null); $(setting_item shields-up).activate(null);
    $HL_EXT._header.activate(null); $(profile_item 3c4d).activate(null); 'ok'" >/dev/null
sleep 0.3
menu_shot "$SHOTS/menu-switching.png"
refresh_now
sleep 1
check "a periodic refresh that completes meanwhile leaves Switching… in place" \
    test "$(shell_eval "$(profile_item 3c4d).progressLabel.text")" = "Switching…"
wait_model "m.pending === null" 10
check "no second action command reached the fake" test "$(action_calls)" = "switch switch 3c4d,"
check "the follow-up ended the progress" test "$(shell_eval "$(profile_item 3c4d).progressLabel.visible")" = false
menu_close

begin "A refresh in flight when the switch ends cannot end the progress"
fake_set status.sleep 2
menu_open
wait_model "!m.accounts.loading"
refresh_now
sleep 0.3
shell_eval "$(profile_item 3c4d).activate(null); 'ok'" >/dev/null
sleep 1.2
check "the switch command ended" test "$(model pending.kind)" = switch
sleep 1.5
# The stale refresh answered at about 2 s and was discarded; the follow-up sleeps until about 4 s.
check "its answer left Switching… and the locks in place" \
    test "$(shell_eval "$(profile_item 3c4d).progressLabel.text + '|' + $(profile_item 3c4d).reactive")" = "Switching…|false"
wait_model "m.pending === null" 10
check "the follow-up's answer ended them" test "$(shell_eval "$(profile_item 3c4d).reactive")" = true
fake_unset status.sleep
menu_close

for pair in needs-login:login needs-approval:approval; do
    blocked=${pair%%:*}
    expected=${pair##*:}
    begin "A failing switch whose follow-up reads $blocked"
    fake_set switch.fail 1
    fake_set switch.stderr "profile needs login"
    menu_open
    wait_model "!m.accounts.loading"
    before=$(fake_count switch-list)
    fake_state "$blocked"
    shell_eval "$(profile_item 3c4d).activate(null); 'ok'" >/dev/null
    wait_model "m.pending === null && m.state.id !== 'connected'" 10
    check "the menu shows $expected and no error block" \
        test "$(model state.id)|$(model actionError)" = "$expected|null"
    check "the profiles were not listed while the section is hidden" test "$(fake_count switch-list)" = "$before"
    menu_close
    menu_open
    check "opening the menu lists nothing" test "$(fake_count switch-list)" = "$before"
    fake_unset switch.fail
    fake_state running
    refresh_now
    wait_model "m.state.id === 'connected'"
    sleep 0.5
    check "Running again with the menu open shows no error block" \
        test "$(menu_texts | grep -c 'profile needs login')" = 0
    check "and lists the profiles once" test "$(fake_count switch-list)" = $((before + 1))
    menu_close
done

begin "Expanded submenus go away with their section"
menu_open
wait_model "!m.accounts.loading"
open_submenu _accountMenu
show needs-login login
check "Account closes and hides when the state has no Account section" \
    test "$(shell_eval "[$HL_EXT._accountMenu.menu.isOpen, $HL_EXT._accountMenu.menu.actor.visible].join()")" = "false,false"
menu_close
show running connected
menu_open
open_submenu _settingsMenu
show needs-approval approval
check "Settings closes and hides the same way" \
    test "$(shell_eval "[$HL_EXT._settingsMenu.menu.isOpen, $HL_EXT._settingsMenu.menu.actor.visible].join()")" = "false,false"
check "the menu shows no Account or Settings text" test "$(menu_texts | grep -c 'Use Tailscale\|example.net')" = 0
menu_close

begin "Settings: each switch runs set, the menu stays open, values follow get"
menu_open
open_submenu _settingsMenu
check "the switches show the values get returned" \
    test "$(shell_eval "['accept-routes', 'accept-dns', 'shields-up'].map(id => $HL_EXT._settingItems[id].state).join()")" = "false,true,false"
menu_shot "$SHOTS/menu-settings-open.png"
pointer_click "$(setting_item accept-routes)"
wait_model "m.pending === null" 10
pointer_click "$(setting_item accept-dns)"
wait_model "m.pending === null" 10
shell_eval "$(setting_item shields-up).activate(null); 'ok'" >/dev/null
wait_model "m.pending === null" 10
check "each switch ran set --<flag>=<value>" test "$(action_calls)" = \
    "set set --accept-routes=true,set set --accept-dns=false,set set --shields-up=true,"
check "the menu stays open" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
check "the Settings submenu stays open" test "$(shell_eval "$HL_EXT._settingsMenu.menu.isOpen")" = true
check "the switches show what get returns" \
    test "$(shell_eval "['accept-routes', 'accept-dns', 'shields-up'].map(id => $HL_EXT._settingItems[id].state).join()")" = "true,false,true"
check "no refresh ran a set" test "$(fake_calls | awk '$1=="set"' | wc -l)" = 3
refresh_now
sleep 0.7
check "a refresh calls no command" test "$(fake_calls | awk '$1=="set"' | wc -l)" = 3
menu_close

begin "A switch shows the requested value while its set runs, then what get returns"
fake_set set.sleep 2
menu_open
open_submenu _settingsMenu
shell_eval "$(setting_item shields-up).activate(null); 'ok'" >/dev/null
sleep 0.8
check "the requested value shows at once" test "$(shell_eval "$(setting_item shields-up).state")" = true
check "the switches are insensitive meanwhile" \
    test "$(shell_eval "Object.values($HL_EXT._settingItems).every(item => !item.reactive)")" = true
menu_shot "$SHOTS/menu-settings-setting.png"
wait_model "m.pending === null" 10
fake_unset set.sleep
check "the new value stays when set worked" test "$(shell_eval "$(setting_item shields-up).state")" = true
check "and the switches are sensitive again" test "$(shell_eval "$(setting_item shields-up).reactive")" = true
fake_set set.fail 1
fake_set set.stderr "boom"
fake_set set.noeffect 1
shell_eval "$(setting_item accept-dns).activate(null); 'ok'" >/dev/null
wait_model "m.pending === null && m.actionError !== null" 10
check "a set that failed without changing it shows the old value" test "$(shell_eval "$(setting_item accept-dns).state")" = true
check "and its error" test "$(model actionError.text)" = boom
fake_unset set.fail
fake_unset set.noeffect
fake_set get.fail 1
shell_eval "$(setting_item accept-dns).activate(null); 'ok'" >/dev/null
wait_model "m.pending === null" 10
check "a get that fails after the set makes the switches insensitive" \
    test "$(shell_eval "Object.values($HL_EXT._settingItems).every(item => !item.reactive)")" = true
menu_close

begin "A failing get keeps Connected, makes the switches insensitive and shows no error"
fake_set get.fail 1
fake_set get.stderr "get is broken"
refresh_now
wait_model "m.prefs === null && m.loaded"
menu_open
open_submenu _settingsMenu
check "the state is still Connected" test "$(model state.id)" = connected
check "the three switches are insensitive" \
    test "$(shell_eval "Object.values($HL_EXT._settingItems).every(item => !item.reactive)")" = true
check "no error block" test "$(menu_texts | grep -c 'get is broken')" = 0
menu_shot "$SHOTS/menu-settings-unreadable.png"
fake_unset get.fail
refresh_now
wait_model "m.prefs !== null"
check "a good read brings the switches back" test "$(shell_eval "$(setting_item accept-dns).reactive")" = true
menu_close

begin "Closing the menu while the refresh after a failing set sleeps shows no error later"
fake_set set.fail 1
fake_set set.stderr "Access denied: prefs write access denied"
fake_set status.sleep 2
menu_open
open_submenu _settingsMenu
shell_eval "$(setting_item shields-up).activate(null); 'ok'" >/dev/null
sleep 0.6
menu_close
wait_model "m.pending === null" 10
fake_unset status.sleep
menu_open
check "reopening shows no error block" test "$(menu_texts | grep -c 'operator')" = 0
menu_close

begin "Sections per state: Disconnected has Account and Settings, Connecting only Account"
show stopped disconnected
menu_open
wait_model "!m.accounts.loading"
check "Disconnected shows Account and Settings, not This device" \
    test "$(shell_eval "[$HL_EXT._accountMenu.visible, $HL_EXT._settingsMenu.visible, $HL_EXT._deviceCaption.visible].join()")" = "true,true,false"
menu_shot "$SHOTS/menu-disconnected-account-settings.png"
menu_close
show connecting connecting
menu_open
check "Connecting shows Account but not Settings" \
    test "$(shell_eval "$HL_EXT._accountMenu.visible + '|' + $HL_EXT._settingsMenu.visible")" = "true|false"
menu_shot "$SHOTS/menu-connecting-account.png"
menu_close
gets=$(fake_count get)
refresh_now
sleep 1
check "get is not called in Connecting" test "$(fake_count get)" = "$gets"
show running connected
check "get is called again in Connected" test "$(fake_count get)" -gt "$gets"

# --- Exit node --------------------------------------------------------------------------------
# Exit node rows are keyed by peer ID: nPEER000000001 is nas (online), ...03 paris-vps (online),
# ...04 tokyo-vps (offline), ...05 oslo-vps (offline, in use; tests/fixtures/status-exit-node.json).
exit_item() { echo "$HL_EXT._exitItems.get('nPEER0000000$1')"; }
# The check marks (PopupMenu.Ornament.CHECK is 2) of None and of the listed nodes, in order.
exit_checks() {
    shell_eval "[$HL_EXT._exitNone, ...[...$HL_EXT._exitItems.values()]].map(item => item._ornament).join()"
}
panel_glyph() { shell_eval "$HL_EXT._icon.gicon.get_file().get_basename()"; }
# Replaces the status of the fake by the Running fixture with the Python edit given as $1 (it
# changes `d`) applied, and waits for the refresh to show it.
edit_status() {
    python3 - "$TAILTRAY_FAKE_DIR/status.json" "$1" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
exec(sys.argv[2])
open(path, 'w').write(json.dumps(d))
PY
}

begin "Exit node: online, offline and checked offline rows; choosing, None, the checked row, LAN"
fake_state exit-node
refresh_now
wait_model "m.status.Peer['nodekey:eeee'] !== undefined"
menu_open
check "the row names the exit node in use" test "$(shell_eval "$HL_EXT._exitSummary.text")" = oslo-vps
check "the panel icon has the exit node badge, the node being offline" \
    test "$(panel_glyph)" = tailtray-exit-symbolic.svg
panel_shot "$SHOTS/panel-exit-node-offline.png"
open_submenu _exitMenu
check "the nodes are sorted by name, then Allow LAN access" \
    test "$(shell_eval "$HL_EXT._exitMenu.menu._getMenuItems().map(item => item.label?.text ?? item.nameLabel?.text).join()")" = \
    "None,nas,oslo-vps,paris-vps,tokyo-vps,Allow LAN access"
check "the node in use is checked, None is not" test "$(exit_checks)" = "0,0,2,0,0"
check "the offline node not in use is the only insensitive row" \
    test "$(shell_eval "[...$HL_EXT._exitItems.values()].map(item => item.reactive).join()")" = "true,true,true,false"
check "the offline nodes show the offline badge" \
    test "$(shell_eval "[...$HL_EXT._exitItems.values()].map(item => item.badge.visible).join()")" = "false,true,false,true"
check "Allow LAN access shows the value of get" test "$(shell_eval "$HL_EXT._lanItem.state")" = false
menu_shot "$SHOTS/menu-exit-node.png"

shell_eval "$(exit_item 04).activate(null); 'ok'" >/dev/null
sleep 0.4
check "an insensitive offline node calls nothing" test "$(action_calls)" = ""
pointer_click "$(exit_item 03)"
wait_model "m.pending === null" 10
check "choosing a node calls set --exit-node=<IPv4>" test "$(action_calls)" = "set set --exit-node=100.64.0.4,"
check "the menu and the submenu stay open" \
    test "$(shell_eval "[$HL_EXT._indicator.menu.isOpen, $HL_EXT._exitMenu.menu.isOpen].join()")" = "true,true"
check "the chosen node is checked, with the row naming it" \
    test "$(exit_checks)|$(shell_eval "$HL_EXT._exitSummary.text")" = "0,0,0,2,0|paris-vps"
check "the badge stays while the node is online" test "$(panel_glyph)" = tailtray-exit-symbolic.svg
shell_eval "$(exit_item 03).activate(null); 'ok'" >/dev/null
sleep 0.4
check "activating the checked row calls nothing" test "$(action_calls)" = "set set --exit-node=100.64.0.4,"
shell_eval "$HL_EXT._exitNone.activate(null); 'ok'" >/dev/null
wait_model "m.pending === null" 10
check "None calls set --exit-node=" \
    test "$(action_calls)" = "set set --exit-node=100.64.0.4,set set --exit-node=,"
check "None is checked and named" \
    test "$(exit_checks)|$(shell_eval "$HL_EXT._exitSummary.text")" = "2,0,0,0,0|None"
check "the badge goes with the exit node" test "$(panel_glyph)" = tailtray-symbolic.svg
shell_eval "$HL_EXT._exitNone.activate(null); 'ok'" >/dev/null
sleep 0.4
check "activating the checked None calls nothing" test "$(fake_calls | awk '$1=="set"' | wc -l)" = 2
pointer_click "$HL_EXT._lanItem"
wait_model "m.pending === null" 10
check "Allow LAN access calls set --exit-node-allow-lan-access=true" \
    test "$(fake_calls | awk '$1=="set"' | tail -1)" = "set set --exit-node-allow-lan-access=true"
check "its switch shows what get returns" test "$(shell_eval "$HL_EXT._lanItem.state")" = true
shell_eval "$HL_EXT._lanItem.activate(null); 'ok'" >/dev/null
wait_model "m.pending === null" 10
check "and toggles back with false" \
    test "$(fake_calls | awk '$1=="set"' | tail -1)" = "set set --exit-node-allow-lan-access=false"
menu_close

begin "Exit node: the badge stays when the node in use goes offline"
fake_state exit-node
edit_status "d['Peer']['nodekey:eeee']['Online'] = True"
refresh_now
wait_model "m.status.Peer['nodekey:eeee'].Online === true"
check "online and in use: badge" test "$(panel_glyph)" = tailtray-exit-symbolic.svg
edit_status "d['Peer']['nodekey:eeee']['Online'] = False"
refresh_now
wait_model "m.status.Peer['nodekey:eeee'].Online === false"
menu_open
open_submenu _exitMenu
check "offline and in use: still checked, with the offline badge, still sensitive" \
    test "$(shell_eval "[$(exit_item 05)._ornament, $(exit_item 05).badge.visible, $(exit_item 05).reactive].join()")" = "2,true,true"
check "offline and in use: still the badge on the icon" test "$(panel_glyph)" = tailtray-exit-symbolic.svg
menu_close

begin "Exit node: the chosen row shows Setting… while a slow set runs, everything else is locked"
fake_state exit-node
refresh_now
wait_model "m.status.Peer['nodekey:eeee'] !== undefined"
fake_set set.sleep 3
menu_open
open_submenu _exitMenu
shell_eval "$(exit_item 03).activate(null); 'ok'" >/dev/null
sleep 1
check "the chosen node shows Setting…" \
    test "$(shell_eval "$(exit_item 03).progressLabel.text + '|' + $(exit_item 03).progressLabel.visible")" = "Setting…|true"
check "no other row shows it" \
    test "$(shell_eval "[$HL_EXT._exitNone, $(exit_item 01), $(exit_item 05)].map(item => item.progressLabel.visible).join()")" = "false,false,false"
check "every row and the LAN switch are insensitive" \
    test "$(shell_eval "[$HL_EXT._exitNone, ...$HL_EXT._exitItems.values(), $HL_EXT._lanItem].every(item => !item.reactive)")" = true
check "so are the Settings switches" \
    test "$(shell_eval "Object.values($HL_EXT._settingItems).every(item => !item.reactive)")" = true
shell_eval "$(exit_item 01).activate(null); $HL_EXT._exitNone.activate(null); 'ok'" >/dev/null
menu_shot "$SHOTS/menu-exit-node-setting.png"
wait_model "m.pending === null" 10
check "no second command reached the fake" test "$(action_calls)" = "set set --exit-node=100.64.0.4,"
shell_eval "$HL_EXT._exitNone.activate(null); 'ok'" >/dev/null
sleep 1
check "None shows Setting… on its own row" \
    test "$(shell_eval "[$HL_EXT._exitNone.progressLabel.text, $HL_EXT._exitNone.progressLabel.visible, $(exit_item 03).progressLabel.visible].join()")" = "Setting…,true,false"
wait_model "m.pending === null" 10
menu_close

begin "Exit node: None available with no option and none in use"
edit_status "
for peer in d['Peer'].values():
    peer['ExitNodeOption'] = False"
refresh_now
wait_model "m.status.Peer['nodekey:aaaa'].ExitNodeOption === false"
menu_open
check "the row reads None available and is insensitive" \
    test "$(shell_eval "$HL_EXT._exitSummary.text + '|' + $HL_EXT._exitMenu.reactive")" = "None available|false"
menu_shot "$SHOTS/menu-exit-node-none-available.png"
menu_close

begin "Exit node: 300 nodes scroll within 280 px, and a refresh updates the rows in place"
python3 - "$TAILTRAY_FAKE_DIR/status.json" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
for i in range(300):
    d['Peer']['nodekey:n%03d' % i] = {
        'ID': 'nBULK%03d' % i, 'HostName': 'exit-%03d' % i, 'DNSName': 'exit-%03d.tail1234.ts.net.' % i,
        'OS': 'linux', 'TailscaleIPs': ['100.65.%d.%d' % (i // 250, i % 250 + 1)], 'Online': i % 3 != 0,
        'ExitNode': False, 'ExitNodeOption': True,
    }
open(path, 'w').write(json.dumps(d))
PY
refresh_now
wait_model "Object.keys(m.status.Peer).length > 300"
menu_open
open_submenu _exitMenu
SCROLL="$HL_EXT._exitMenu.menu.actor"
check "the submenu lists the 300 nodes and nas" test "$(shell_eval "$HL_EXT._exitItems.size")" = 301
# The headless screen is only 1200 px high, so the main menu may squeeze the submenu below its
# natural height: the natural height is what the 280 px cap limits.
check "the submenu is at most 280 px high" \
    test "$(shell_eval "$SCROLL.get_preferred_height(-1)[1]")" = 280
check "its rows are far taller than that, so they scroll" \
    test "$(shell_eval "$SCROLL.vadjustment.upper > 10 * $SCROLL.vadjustment.page_size")" = true
menu_shot "$SHOTS/menu-exit-node-300-top.png"
# A real wheel turn over the rows, not a write to the adjustment.
read -r sx sy <<<"$(shell_eval "(([x, y], [w, h]) => [x + w / 2, y + h / 2].join(' '))($SCROLL.get_transformed_position(), $SCROLL.get_transformed_size())")"
shell_eval "globalThis.__pointer.notify_absolute_motion(GLib.get_monotonic_time(), $sx, $sy); 'ok'" >/dev/null
sleep 0.4
before=$(shell_eval "Math.round($SCROLL.vadjustment.value)")
for _ in 1 2 3 4 5; do
    shell_eval "globalThis.__pointer.notify_discrete_scroll(GLib.get_monotonic_time(),
        Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL); 'ok'" >/dev/null
    sleep 0.2
done
sleep 0.5
check "the mouse wheel scrolls the rows" test "$(shell_eval "$SCROLL.vadjustment.value > $before + 50")" = true
shell_eval "$SCROLL.vadjustment.value = 1000; 'ok'" >/dev/null
sleep 0.5
check "scrolling to a row moves the rows there" test "$(shell_eval "Math.round($SCROLL.vadjustment.value)")" = 1000
menu_shot "$SHOTS/menu-exit-node-300-scrolled.png"
shell_eval "globalThis.__row = $HL_EXT._exitItems.get('nBULK150'); globalThis.__none = $HL_EXT._exitNone; 'ok'" >/dev/null
edit_status "
d['Peer']['nodekey:n150']['Online'] = False
d['Peer']['nodekey:n150']['ExitNode'] = True
del d['Peer']['nodekey:n299']
d['Peer']['nodekey:new'] = dict(d['Peer']['nodekey:n001'], ID='nBULKNEW', HostName='exit-new', DNSName='exit-new.tail1234.ts.net.')"
refresh_now
wait_model "m.status.Peer['nodekey:n150'].ExitNode === true"
sleep 0.5
check "the row of a peer is the same object after a refresh" \
    test "$(shell_eval "$HL_EXT._exitItems.get('nBULK150') === globalThis.__row && $HL_EXT._exitNone === globalThis.__none")" = true
check "which now shows the offline badge and the check mark" \
    test "$(shell_eval "[globalThis.__row.badge.visible, globalThis.__row._ornament].join()")" = "true,2"
check "a vanished peer lost its row and a new one has one" \
    test "$(shell_eval "[$HL_EXT._exitItems.has('nBULK299'), $HL_EXT._exitItems.has('nBULKNEW'), $HL_EXT._exitItems.size].join()")" = "false,true,301"
check "the submenu is still open and still scrolled" \
    test "$(shell_eval "[$HL_EXT._exitMenu.menu.isOpen, Math.round($SCROLL.vadjustment.value)].join()")" = "true,1000"
check "the row summary follows" test "$(shell_eval "$HL_EXT._exitSummary.text")" = exit-150
check "the order is by name, the new node after exit-299's place" \
    test "$(shell_eval "$HL_EXT._exitMenu.menu._getMenuItems().slice(-4).map(item => item.nameLabel?.text ?? item.label.text).join()")" = \
    "exit-298,exit-new,nas,Allow LAN access"
menu_close

# --- Other devices ----------------------------------------------------------------------------
# Devices are keyed by peer ID: nDEV1 home-router, 2 laptop, 3 paris-vps, 4 phone (online), 5 nas
# (seen 3 days ago), 6 tokyo-vps (seen 2 months ago), and 7 mullvad-fr, which has a Location and
# is never listed. Addresses are 100.64.1.<n> and fd7a:115c:a1e0::<n>.
dev() { echo "$HL_EXT._deviceEntries.get('nDEV$1')"; }
# One value per listed device, in order: a JavaScript expression of the entry `e`.
dev_texts() {
    shell_eval "[...$HL_EXT._deviceEntries.values()].map(e => $1).join('|')"
}
# The names of the devices in the order the list shows them, not the order the rows were made in.
dev_order() {
    shell_eval "$HL_EXT._devicesList.box.get_children().map(a => a._delegate.nameLabel?.text ?? [...$HL_EXT._deviceEntries.values()].find(e => e.section.actor === a).row.nameLabel.text).join('|')"
}
# The arguments of every ping the fake received, one per line.
ping_calls() { fake_calls | awk '$1 == "ping"' | sed 's/^ping ping //'; }
# Shows the devices of the fake in the model.
show_devices() {
    fake_devices "${1:-0}"
    refresh_now
    wait_model "m.status.Peer['nodekey:nDEV1'] !== undefined"
}

begin "Other devices: list, order, expanding, ping results"
show_devices
menu_open
check "the caption counts the listed devices" \
    test "$(shell_eval "$HL_EXT._devicesCaptionLabel.text")" = "Other devices · 4 of 6 online"
check "online devices come first, each group by name; the Location peer is not listed" \
    test "$(dev_order)" = "home-router|laptop|paris-vps|phone|nas|tokyo-vps"
check "an online device shows its OS, an offline one when it was last seen" \
    test "$(dev_texts "e.row.detailLabel.text")" = "linux|macOS|linux|iOS|3 days ago|2 months ago"
check "offline names are dimmed" \
    test "$(dev_texts "e.row.nameLabel.opacity < 255")" = "false|false|false|false|true|true"
check "no device is expanded" test "$(dev_texts "e.body.actor.visible")" = "false|false|false|false|false|false"
check "the list sits between Settings and the footer, a separator on each side" \
    test "$(shell_eval "(items => [items.indexOf($HL_EXT._settingsMenu) < items.indexOf($HL_EXT._separators.controls), items.indexOf($HL_EXT._separators.controls) < items.indexOf($HL_EXT._devicesCaption), items.indexOf($HL_EXT._devicesCaption) < items.indexOf($HL_EXT._devicesSection), items.indexOf($HL_EXT._devicesSection) < items.indexOf($HL_EXT._separators.footer), $HL_EXT._separators.controls.visible, $HL_EXT._separators.footer.visible].join())($HL_EXT._indicator.menu._getMenuItems())")" = "true,true,true,true,true,true"
pointer_park
menu_shot "$SHOTS/menu-devices.png"

pointer_click "$(dev 1).row"
check "a click expands a device" test "$(dev_texts "e.body.actor.visible")" = "true|false|false|false|false|false"
check "it shows its name and addresses with a copy icon, then Ping" \
    test "$(shell_eval "$(dev 1).body._getMenuItems().filter(i => i.visible).map(i => i.valueLabel?.text ?? 'Ping').join()")" = \
    "home-router.tail1234.ts.net,100.64.1.1,fd7a:115c:a1e0::1,Ping"
pointer_click "$(dev 2).row"
check "expanding another device collapses the one that was open" \
    test "$(dev_texts "e.body.actor.visible")" = "false|true|false|false|false|false"
pointer_click "$(dev 2).row"
check "a click on the expanded device collapses it" \
    test "$(dev_texts "e.body.actor.visible")" = "false|false|false|false|false|false"

# Each kind of result, from outputs captured by the real CLI or built from its format strings.
fake_pong 1 home-router 192.0.2.10:41641 4ms
fake_pong 2 laptop "DERP(nyc)" 26ms
fake_pong 3 paris-vps "peer-relay(192.0.2.20:40000:vni:1234)" 31ms
fake_set ping.100.64.1.4.out 'ping "100.64.1.4" timed out'
fake_set ping.100.64.1.4.err 'no reply'
fake_set ping.100.64.1.4.exit 1
for n in 1 2 3 4; do
    pointer_click "$(dev $n).row"
    pointer_click "$(dev $n).ping"
    wait_for "$(dev $n).ping.resultLabel.text !== '…' && $(dev $n).ping.resultLabel.text !== ''" 10
    pointer_click "$(dev $n).row"
done
check "each Ping ran tailscale ping -c 1 --until-direct=false --timeout 5s on the IPv4 address" \
    test "$(ping_calls | sort | tr '\n' ,)" = \
    "-c 1 --until-direct=false --timeout 5s 100.64.1.1,-c 1 --until-direct=false --timeout 5s 100.64.1.2,-c 1 --until-direct=false --timeout 5s 100.64.1.3,-c 1 --until-direct=false --timeout 5s 100.64.1.4,"
check "each result is shown on its row: direct, relay, peer relay, no answer" \
    test "$(dev_texts "e.ping.resultLabel.text")" = "direct · 4 ms|relay nyc · 26 ms|peer relay · 31 ms|no answer||"
check "a ping keeps the menu open" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
pointer_click "$(dev 1).row"
sleep 0.3
check "the result is still there when the device is expanded again" \
    test "$(shell_eval "$(dev 1).ping.resultLabel.text + '|' + $(dev 1).ping.resultLabel.visible")" = "direct · 4 ms|true"
pointer_park
menu_shot "$SHOTS/menu-devices-ping.png"
menu_close

begin "Other devices: Ping is insensitive for an offline device or one without an IPv4 address"
fake_devices
edit_status "d['Peer']['nodekey:nDEV4']['TailscaleIPs'] = ['fd7a:115c:a1e0::4']"
refresh_now
wait_model "m.status.Peer['nodekey:nDEV4'].TailscaleIPs.length === 1"
menu_open
check "Ping is sensitive for an online device with an IPv4 address only" \
    test "$(dev_texts "e.ping.reactive")" = "true|true|true|false|false|false"
pointer_click "$(dev 5).row"
check "an expanded offline device shows its addresses and a greyed Ping" \
    test "$(shell_eval "$(dev 5).body.actor.visible + '|' + $(dev 5).ping.reactive + '|' + $(dev 5).copy.ipv4.valueLabel.text")" = "true|false|100.64.1.5"
shell_eval "$(dev 5).ping.activate(null); $(dev 4).ping.activate(null); 'ok'" >/dev/null
sleep 1
check "activating an insensitive Ping runs nothing" test "$(fake_count ping)" = 0
check "and shows no result" test "$(dev_texts "e.ping.resultLabel.visible")" = "false|false|false|false|false|false"
pointer_park
menu_shot "$SHOTS/menu-devices-offline.png"
menu_close

begin "Other devices: a refresh keeps the expanded device and its ping result"
fake_pong 2 laptop 192.0.2.11:41641 7ms
show_devices
menu_open
pointer_click "$(dev 2).row"
pointer_click "$(dev 2).ping"
wait_for "$(dev 2).ping.resultLabel.text === 'direct · 7 ms'" 10
shell_eval "globalThis.__laptop = $(dev 2); 'ok'" >/dev/null
# A device goes offline, one arrives and sorts first, another vanishes.
edit_status "
d['Peer']['nodekey:nDEV3']['Online'] = False
d['Peer']['nodekey:nDEV3']['LastSeen'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
del d['Peer']['nodekey:nDEV6']
d['Peer']['nodekey:new'] = dict(d['Peer']['nodekey:nDEV1'], ID='nDEV8', HostName='aaa-new', DNSName='aaa-new.tail1234.ts.net.', TailscaleIPs=['100.64.1.8'])"
refresh_now
wait_model "m.status.Peer['nodekey:new'] !== undefined"
sleep 0.5
check "the device is the same row, still expanded, with its result" \
    test "$(shell_eval "$(dev 2) === globalThis.__laptop && $(dev 2).body.actor.visible && $(dev 2).ping.resultLabel.text === 'direct · 7 ms'")" = true
check "the list follows the new status" \
    test "$(dev_order)" = "aaa-new|home-router|laptop|phone|nas|paris-vps"
check "the caption follows" test "$(shell_eval "$HL_EXT._devicesCaptionLabel.text")" = "Other devices · 4 of 6 online"
check "the menu is still open" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
# An expanded device that vanishes takes its expansion and result with it.
edit_status "del d['Peer']['nodekey:nDEV2']"
refresh_now
wait_model "m.status.Peer['nodekey:nDEV2'] === undefined"
sleep 0.3
check "a vanished device has no row, and nothing else is expanded" \
    test "$(dev_texts "e.body.actor.visible")" = "false|false|false|false|false"
menu_close

begin "Other devices: 60 devices scroll within 280 px"
fake_devices 54
refresh_now
wait_model "Object.keys(m.status.Peer).length > 60"
menu_open
SCROLL="$HL_EXT._devicesScroll"
check "the list holds the 60 devices" test "$(shell_eval "$HL_EXT._deviceEntries.size")" = 60
check "the caption counts all of them" \
    test "$(shell_eval "$HL_EXT._devicesCaptionLabel.text")" = "Other devices · 40 of 60 online"
check "the list is at most 280 px high" test "$(shell_eval "$SCROLL.get_preferred_height(-1)[1]")" = 280
check "its rows are far taller than that, so they scroll" \
    test "$(shell_eval "$SCROLL.vadjustment.upper > 5 * $SCROLL.vadjustment.page_size")" = true
pointer_park
menu_shot "$SHOTS/menu-devices-60-top.png"
read -r sx sy <<<"$(shell_eval "(([x, y], [w, h]) => [x + w / 2, y + h / 2].join(' '))($SCROLL.get_transformed_position(), $SCROLL.get_transformed_size())")"
shell_eval "globalThis.__pointer.notify_absolute_motion(GLib.get_monotonic_time(), $sx, $sy); 'ok'" >/dev/null
sleep 0.4
for _ in 1 2 3 4 5; do
    shell_eval "globalThis.__pointer.notify_discrete_scroll(GLib.get_monotonic_time(),
        Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL); 'ok'" >/dev/null
    sleep 0.2
done
sleep 0.5
check "the mouse wheel scrolls the rows" test "$(shell_eval "$SCROLL.vadjustment.value > 50")" = true
shell_eval "$SCROLL.vadjustment.value = 600; 'ok'" >/dev/null
sleep 0.5
pointer_park
menu_shot "$SHOTS/menu-devices-60-scrolled.png"
shell_eval "globalThis.__row = $(dev 100); 'ok'" >/dev/null
refresh_now
sleep 1
check "a refresh keeps the rows and the scroll position" \
    test "$(shell_eval "$(dev 100) === globalThis.__row && Math.round($SCROLL.vadjustment.value)")" = 600
menu_close

begin "Other devices: closing the menu during a slow ping kills it, and reopening shows no result"
fake_pong 1 home-router 192.0.2.10:41641 4ms
fake_set ping.100.64.1.1.sleep 30
show_devices
menu_open
pointer_click "$(dev 1).row"
pointer_click "$(dev 1).ping"
wait_for "$(dev 1).ping.resultLabel.text === '…'" 10
check "the ping runs and shows …" test "$(pids_of_fake)" -ge 1
shell_eval "$(dev 1).ping.activate(null); 'ok'" >/dev/null
sleep 0.5
check "a second Ping on the same device does nothing" test "$(fake_count ping)" = 1
menu_close
sleep 1
check "closing the menu killed the ping" test "$(pids_of_fake)" = 0
fake_unset ping.100.64.1.1.sleep
menu_open
check "reopening shows no result and no expanded device" \
    test "$(shell_eval "$(dev 1).ping.resultLabel.visible + '|' + $(dev 1).ping.resultLabel.text + '|' + $(dev 1).body.actor.visible")" = "false||false"
sleep 2
check "and none appears later" test "$(shell_eval "$(dev 1).ping.resultLabel.text")" = ""
menu_close

begin "Other devices: two devices ping at once, while an action runs"
fake_pong 1 home-router 192.0.2.10:41641 4ms
fake_pong 2 laptop "DERP(nyc)" 26ms
fake_set ping.sleep 3
fake_set down.sleep 4
show_devices
menu_open
shell_eval "$HL_EXT._header.activate(null); 'ok'" >/dev/null
sleep 0.3
start=$(date +%s.%N)
shell_eval "$(dev 1).ping.activate(null); $(dev 2).ping.activate(null); 'ok'" >/dev/null
sleep 1
check "an action is pending and both pings run next to it" \
    test "$(model pending.kind)|$(pids_of_fake)" = "down|3"
check "both rows show …" test "$(dev_texts "e.ping.resultLabel.text" | cut -d'|' -f1-2)" = "…|…"
wait_for "$(dev 1).ping.resultLabel.text !== '…' && $(dev 2).ping.resultLabel.text !== '…'" 10
elapsed=$(python3 -c "print($(date +%s.%N) - $start)")
check "the pings overlapped: both answered in about 3 s, not 6" \
    test "$(python3 -c "print(int(3 <= $elapsed < 5))")" = 1
check "each row has its own result" \
    test "$(dev_texts "e.ping.resultLabel.text" | cut -d'|' -f1-2)" = "direct · 4 ms|relay nyc · 26 ms"
wait_model "m.pending === null" 10
menu_close

begin "Other devices: a ping past its time limit reads no answer, a vanished device's ping is killed"
fake_set ping.sleep 60
show_devices
shell_eval "GLib.setenv('TAILTRAY_TIMEOUT_SECONDS', '2', true); 'ok'" >/dev/null
ext_reload
wait_model "m.loaded"
menu_open
shell_eval "$(dev 1).ping.activate(null); 'ok'" >/dev/null
wait_for "$(dev 1).ping.resultLabel.text === 'no answer'" 8
check "the ping killed at its limit reads no answer" test "$(shell_eval "$(dev 1).ping.resultLabel.text")" = "no answer"
check "and no tailscale child is left" test "$(pids_of_fake)" = 0
menu_close
shell_eval "GLib.unsetenv('TAILTRAY_TIMEOUT_SECONDS'); 'ok'" >/dev/null
ext_reload
wait_model "m.loaded"
menu_open
shell_eval "$(dev 2).ping.activate(null); 'ok'" >/dev/null
sleep 0.7
check "a slow ping runs" test "$(pids_of_fake)" -ge 1
edit_status "del d['Peer']['nodekey:nDEV2']"
refresh_now
wait_model "m.status.Peer['nodekey:nDEV2'] === undefined"
sleep 1
check "the device vanished: its ping was killed" test "$(pids_of_fake)" = 0
menu_close

begin "Other devices: disabling kills a ping; other states and an empty tailnet"
fake_set ping.sleep 60
show_devices
menu_open
shell_eval "$(dev 1).ping.activate(null); 'ok'" >/dev/null
sleep 0.7
check "a slow ping runs" test "$(pids_of_fake)" -ge 1
shell_eval "Main.extensionManager.disableExtension('$HL_UUID'); 'ok'" >/dev/null
sleep 1
check "disabling killed it" test "$(pids_of_fake)" = 0
check "disabling with the menu open touched no destroyed actor" \
    test "$(grep -c 'disposed' "$WORK/shell.log")" = 0
shell_eval "Main.extensionManager.enableExtension('$HL_UUID'); 'ok'" >/dev/null
wait_for "Main.extensionManager.lookup('$HL_UUID')?.state === 1"
wait_model "m.loaded"
show stopped disconnected
menu_open
check "Disconnected shows no Other devices" \
    test "$(shell_eval "$HL_EXT._devicesCaption.visible + '|' + $HL_EXT._devicesSection.actor.visible")" = "false|false"
menu_close
fake_state running
edit_status "d['Peer'] = {}"
refresh_now
wait_model "m.state.id === 'connected' && Object.keys(m.status.Peer).length === 0"
menu_open
check "without peers the caption reads No other devices and there is no row" \
    test "$(shell_eval "$HL_EXT._devicesCaptionLabel.text + '|' + $HL_EXT._devicesSection.actor.visible + '|' + $HL_EXT._deviceEntries.size")" = "No other devices|false|0"
pointer_park
menu_shot "$SHOTS/menu-devices-none.png"
menu_close

# --- Reading the state ------------------------------------------------------------------------
begin "Refresh rules"
fake_set status.sleep 2
shell_eval "(() => { const e = $HL_EXT._engine; e.requestRefresh(); e.requestRefresh(); e.requestRefresh(); return 'ok'; })()" >/dev/null
sleep 6
# The reload's own refresh (it finished before the sleep was set) and then one queued one.
check "three requests during a slow refresh run one more" test "$(fake_count status)" = 3
fake_unset status.sleep

begin "A new refresh interval applies from the next scheduled refresh" 60
before=$(fake_count status)
set_interval 5
sleep 7
check "the pending timer keeps the old interval" test "$(fake_count status)" = "$before"
refresh_now
sleep 6.5
check "the next scheduled refresh uses the new one" test "$(fake_count status)" = $((before + 2))

begin "Opening the menu and Refresh now refresh"
before=$(fake_count status)
menu_open
sleep 0.6
check "opening the menu ran one status" test "$(fake_count status)" = $((before + 1))
pointer_click "$HL_EXT._refreshItem"
sleep 0.6
check "Refresh now ran one more status" test "$(fake_count status)" = $((before + 2))
check "Refresh now keeps the menu open" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
menu_close

begin "A refresh started before an action ended is discarded"
menu_open
fake_set status.sleep 3
refresh_now
sleep 0.5
fake_set down.sleep 0
updated=$(model updatedAt)
shell_eval "$HL_EXT._header.activate(null)" >/dev/null
sleep 0.5
fake_state stopped
sleep 3
check "its result changed nothing" test "$(model updatedAt)" = "$updated"
check "the action is still pending until its follow-up answers" test "$(model pending.kind)" = down
fake_unset status.sleep
wait_model "m.pending === null" 10
check "the follow-up shows the new state" test "$(model state.id)" = disconnected

begin "A sleeping read is killed at its time limit"
shell_eval "GLib.setenv('TAILTRAY_TIMEOUT_SECONDS', '2', true); 'ok'" >/dev/null
fake_set status.sleep 60
ext_reload
wait_model "m.state.id === 'unavailable'" 10
check "the killed read shows Unavailable" test "$(model refreshError.text)" = "The command timed out."
check "no tailscale child left" test "$(pids_of_fake)" = 0

# --- Notifications ----------------------------------------------------------------------------
# The notifications in the message tray, as "title: body" joined by |, oldest first.
tray() {
    shell_eval "Main.messageTray.getSources().flatMap(source => source.notifications
        .map(n => n.title + ': ' + n.body)).join('|')"
}
tray_count() {
    shell_eval "Main.messageTray.getSources().reduce((sum, source) => sum + source.notifications.length, 0)"
}
# Runs JavaScript on the first notification of the tray whose title is $1: `n` is that notification.
on_notification() {
    shell_eval "(n => { $2 })(Main.messageTray.getSources().flatMap(s => s.notifications)
        .find(n => n.title === '$1'))"
}
# The banner stays a few seconds: wait for it to be fully shown, then capture the screen.
banner_shot() {
    wait_for "!!Main.messageTray._banner && Main.messageTray._banner.mapped"
    sleep 1
    screenshot "$SHOTS/$1.png"
}
# Asks for a refresh and waits until it has been applied, so a check made after it cannot beat a
# notification it would send.
refresh_applied() {
    local previous
    previous=$(model updatedAt)
    refresh_now
    wait_model "m.updatedAt !== $previous"
    sleep 0.3
}
# Sets the Self ID and key expiry (in days from now) of the fake's status.
fake_key() {
    edit_status "import datetime
d['Self']['ID'] = '$1'
d['Self']['KeyExpiry'] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=$2, hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ')"
    local expiry
    expiry=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["Self"]["KeyExpiry"])' \
        "$TAILTRAY_FAKE_DIR/status.json")
    refresh_now
    wait_model "m.status.Self.ID === '$1' && m.status.Self.KeyExpiry === '$expiry'"
}

NOTIFICATIONS=true begin "Notifications: the baseline sends nothing, each transition notifies once"
check "the Notifications preference is on by default" \
    test "$(gsettings reset "$HL_SCHEMA" notifications; gsettings get "$HL_SCHEMA" notifications)" = true
check "the first refresh sends no notification" test "$(tray_count)" = 0
show stopped disconnected
check "Connection lost, with the new header label" test "$(tray)" = "Connection lost: Disconnected"
banner_shot notification-connection-lost
refresh_applied
check "a refresh in the same state sends nothing more" test "$(tray_count)" = 1
fake_set status.fail 1
fake_set status.stderr "failed to connect to local tailscaled; it doesn't appear to be running"
refresh_now
wait_model "m.state.id === 'unavailable'"
fake_unset status.fail
fake_unset status.stderr
show stopped disconnected
check "a failed refresh in between is not a transition" test "$(tray_count)" = 1
show needs-login login
check "Login required notifies, with the header label" \
    test "$(tray)" = "Connection lost: Disconnected|Login required: Login required"
show needs-approval approval
check "Login required to Approval required sends nothing more" test "$(tray_count)" = 2
show running connected
check "Login required is withdrawn once the state leaves it, the other stays" \
    test "$(tray)" = "Connection lost: Disconnected"
shell_eval "Main.messageTray.getSources().forEach(source => source.destroy()); 'ok'" >/dev/null
check "dismissing everything empties the tray" test "$(tray_count)" = 0
show needs-login login
check "Login required notifies again after the tray was emptied" \
    test "$(tray)" = "Connection lost: Login required|Login required: Login required"
on_notification "Login required" "n.destroy(); return 'ok'" >/dev/null
show running connected
check "withdrawing a Login required notification already dismissed is silent" \
    test "$(tray)" = "Connection lost: Login required"
show stopped disconnected
check "after a dismissal the next transition still notifies" \
    test "$(tray)" = "Connection lost: Login required|Connection lost: Disconnected"
check "no JS ERROR or JS WARNING so far" assert_log_clean

NOTIFICATIONS=true begin "Notifications: a failed refresh between two good ones is not compared"
fake_set status.fail 1
fake_set status.stderr "failed to connect to local tailscaled; it doesn't appear to be running"
refresh_now
wait_model "m.state.id === 'unavailable'"
check "an Unavailable refresh sends nothing" test "$(tray_count)" = 0
fake_unset status.fail
fake_unset status.stderr
show stopped disconnected
check "the loss is seen against the last good refresh, Connected" test "$(tray)" = "Connection lost: Disconnected"
shell_eval "Main.messageTray.getSources().forEach(source => source.destroy()); 'ok'" >/dev/null
show running connected
fake_set status.fail 1
refresh_now
wait_model "m.state.id === 'unavailable'"
fake_unset status.fail
show running connected
check "Connected, failed, Connected sends nothing" test "$(tray_count)" = 0

NOTIFICATIONS=true begin "Notifications: activating opens the menu, and the next transition still notifies"
show stopped disconnected
check "the notification exists" test "$(tray)" = "Connection lost: Disconnected"
check "the menu is closed" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = false
on_notification "Connection lost" "n.activate(); return 'ok'" >/dev/null
wait_for "$HL_EXT._indicator.menu.isOpen"
check "activating Connection lost opens the menu" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
check "an activated notification is gone" test "$(tray_count)" = 0
menu_close
show needs-login login
check "the next transition notifies" test "$(tray)" = "Login required: Login required"
on_notification "Login required" "n.activate(); return 'ok'" >/dev/null
wait_for "$HL_EXT._indicator.menu.isOpen"
check "activating Login required opens the menu" test "$(shell_eval "$HL_EXT._indicator.menu.isOpen")" = true
menu_close
show running connected
show stopped disconnected
check "and the one after" test "$(tray)" = "Connection lost: Disconnected"

NOTIFICATIONS=true begin "Notifications: an action of Tailtray explains the lost connection"
shell_eval "$HL_EXT._engine.runAction('down', ['down']); 'ok'" >/dev/null
wait_model "m.state.id === 'disconnected' && m.pending === null"
check "disconnecting from the menu sends no Connection lost" test "$(tray_count)" = 0
show running connected
fake_state stopped
shell_eval "$HL_EXT._engine._lastActionMs = Date.now() - 31000; 'ok'" >/dev/null
refresh_now
wait_model "m.state.id === 'disconnected'"
check "the same loss 31 seconds after an action does notify" test "$(tray)" = "Connection lost: Disconnected"

NOTIFICATIONS=true begin "Notifications: an exit node going offline"
fake_state exit-node
edit_status "d['Peer']['nodekey:eeee']['Online'] = True"
refresh_now
wait_model "m.status.Peer['nodekey:eeee']?.Online === true"
check "an exit node already in use sends nothing" test "$(tray_count)" = 0
edit_status "d['Peer']['nodekey:eeee']['Online'] = False"
refresh_now
wait_model "m.status.Peer['nodekey:eeee'].Online === false"
check "Exit node offline names the node" test "$(tray)" = "Exit node offline: oslo-vps is offline."
refresh_applied
check "it is not repeated" test "$(tray_count)" = 1
edit_status "d['Peer']['nodekey:eeee']['Online'] = True"
refresh_now
wait_model "m.status.Peer['nodekey:eeee'].Online === true"
shell_eval "Main.messageTray.getSources().forEach(source => source.destroy()); 'ok'" >/dev/null
edit_status "
d['Peer']['nodekey:eeee']['ExitNode'] = False
d['Peer']['nodekey:cccc']['ExitNode'] = True
d['Peer']['nodekey:cccc']['Online'] = False"
refresh_now
wait_model "m.status.Peer['nodekey:cccc'].ExitNode === true"
check "one exit node replaced by another, the old one offline, sends nothing" test "$(tray_count)" = 0

NOTIFICATIONS=true begin "Notifications: a key expiring is notified once"
fake_key nSELF000000000 3
check "Key expiring uses the warning text" test "$(tray)" = "Key expiring: This device's key expires in 3 days."
banner_shot notification-key-expiring
refresh_applied
check "not repeated by the next refresh" test "$(tray_count)" = 1
check "the pair is stored" test "$(gsettings get "$HL_SCHEMA" notified-key-expiries | grep -c nSELF000000000)" = 1
shell_eval "Main.messageTray.getSources().forEach(source => source.destroy()); 'ok'" >/dev/null
shell_restart
wait_model "m.loaded"
check "not repeated after restarting the shell" test "$(tray_count)" = 0
# Switching account: the fake's status carries the other account's key, as the real CLI's would.
switch_account() {
    edit_status "d['Self']['ID'] = '$2'
d['Self']['KeyExpiry'] = '$3'"
    shell_eval "$HL_EXT._engine.runAction('switch', ['switch', '$1'], {id: '$1'}); 'ok'" >/dev/null
    wait_model "m.status.Self.ID === '$2' && m.pending === null"
    sleep 0.5
}
account_a_expiry=$(model status.Self.KeyExpiry)
account_b_expiry=$(date -u -d "+5 days 1 hour" +%Y-%m-%dT%H:%M:%SZ)
switch_account 3c4d nOTHER0000000 "$account_b_expiry"
check "another account's key is notified" test "$(tray)" = "Key expiring: This device's key expires in 5 days."
shell_eval "Main.messageTray.getSources().forEach(source => source.destroy()); 'ok'" >/dev/null
switch_account 1a2b nSELF000000000 "$account_a_expiry"
check "switching back to the first account does not notify again" test "$(tray_count)" = 0
switch_account 3c4d nOTHER0000000 "$account_b_expiry"
check "nor does switching to the second one again" test "$(tray_count)" = 0
check "both pairs are remembered" \
    test "$(gsettings get "$HL_SCHEMA" notified-key-expiries | grep -o 'nSELF000000000\|nOTHER0000000' | wc -l)" = 2

begin "Notifications: none with the preference off"
show stopped disconnected
show needs-login login
fake_key nSELF000000000 2
sleep 0.5
check "no notification while the preference is off" test "$(tray_count)" = 0
check "a key expiry not sent is not remembered" \
    test "$(gsettings get "$HL_SCHEMA" notified-key-expiries)" = "@as []"
gsettings set "$HL_SCHEMA" notifications true
refresh_now
wait_model "m.loaded"
sleep 0.5
check "turning it on notifies the key expiry at the next refresh, and no transition" \
    test "$(tray)" = "Key expiring: This device's key expires in 2 days."

NOTIFICATIONS=true begin "Notifications: disabling the extension removes them"
show stopped disconnected
show needs-login login
check "two notifications" test "$(tray_count)" = 2
shell_eval "Main.extensionManager.disableExtension('$HL_UUID'); 'ok'" >/dev/null
sleep 1
check "the tray is empty once disabled" test "$(shell_eval "Main.messageTray.getSources().length")" = 0

# --- Lifecycle --------------------------------------------------------------------------------
begin "Disabling kills a sleeping command and leaves no timer"
fake_set status.sleep 60
ext_reload
sleep 0.5
check "the fake is running" test "$(pids_of_fake)" -ge 1
shell_eval "Main.extensionManager.disableExtension('$HL_UUID'); 'ok'" >/dev/null
sleep 1
check "disabling killed it" test "$(pids_of_fake)" = 0
fake_unset status.sleep
set_interval 5
before=$(fake_count status)
sleep 7
check "no refresh ran while disabled" test "$(fake_count status)" = "$before"
before=$(fake_count status)
shell_eval "Main.extensionManager.enableExtension('$HL_UUID'); 'ok'" >/dev/null
wait_for "Main.extensionManager.lookup('$HL_UUID')?.state === 1"
sleep 12
# At 0, 5 and 10 seconds: a timer left by the disabled instance would add more.
check "re-enabling counts one timer's refreshes" test "$(($(fake_count status) - before))" -ge 3
check "re-enabling counts one timer's refreshes (no more)" test "$(($(fake_count status) - before))" -le 3

begin "A reply delayed past a disable and re-enable changes nothing"
fake_set status.sleep 3
ext_reload
shell_eval "Main.extensionManager.disableExtension('$HL_UUID'); 'ok'" >/dev/null
fake_unset status.sleep
fake_state stopped
shell_eval "Main.extensionManager.enableExtension('$HL_UUID'); 'ok'" >/dev/null
wait_for "Main.extensionManager.lookup('$HL_UUID')?.state === 1"
wait_model "m.state.id === 'disconnected'"
updated=$(model updatedAt)
sleep 4
check "the new instance kept its own answer" test "$(model state.id)" = disconnected
check "nothing touched it" test "$(model updatedAt)" = "$updated"

# --- Preferences ------------------------------------------------------------------------------
NOTIFICATIONS=true begin "Preferences chosen in the preferences window survive a restart"
PREFS="global.display.list_all_windows().find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions')"
menu_open
pointer_click "$HL_EXT._preferencesItem"
wait_for "!!$PREFS" 90
check "the Preferences row opens the preferences window" test "$(shell_eval "!!$PREFS")" = true
shell_eval "$PREFS.activate(global.get_current_time()); 'ok'" >/dev/null
wait_for "$PREFS.has_focus()"
sleep 1.5
read -r px py <<<"$(shell_eval "(r => [r.x, r.y].join(' '))($PREFS.get_frame_rect())")"
check "the window starts at the default interval" test "$(gsettings get "$HL_SCHEMA" refresh-interval)" = "uint32 60"
check "the Notifications switch starts on" test "$(gsettings get "$HL_SCHEMA" notifications)" = true
pointer_park
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.ScreenshotWindow true false false "$SHOTS/prefs-notifications-on.png" >/dev/null
# Offsets of the Refresh interval row and of its "5 seconds" choice, in the default window.
pointer_click_at $((px + 515)) $((py + 137))
sleep 1
screenshot "$SHOTS/prefs-interval-open.png"
pointer_click_at $((px + 547)) $((py + 182))
sleep 1
check "choosing 5 seconds saves it at once" test "$(gsettings get "$HL_SCHEMA" refresh-interval)" = "uint32 5"
# The Notifications switch sits at the right of the row under it.
pointer_click_at $((px + 549)) $((py + 198))
sleep 1
check "turning Notifications off saves it at once" test "$(gsettings get "$HL_SCHEMA" notifications)" = false
pointer_park
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.ScreenshotWindow true false false "$SHOTS/prefs.png" >/dev/null
shell_eval "$PREFS.delete(global.get_current_time()); 'ok'" >/dev/null
sleep 1
shell_restart
check "the interval is still 5 seconds after restarting the shell" \
    test "$(gsettings get "$HL_SCHEMA" refresh-interval)" = "uint32 5"
check "Notifications is still off after restarting the shell" \
    test "$(gsettings get "$HL_SCHEMA" notifications)" = false
wait_model "m.loaded"
before=$(fake_count status)
sleep 7.5
check "the refresh timer follows it" test "$(fake_count status)" = $((before + 1))

check "the shell log has no JS ERROR or JS WARNING" assert_log_clean

echo
if ((HL_FAILURES > 0)); then
    echo "$HL_FAILURES check(s) failed. Screenshots: $SHOTS"
    exit 1
fi
echo "All checks passed. Screenshots: $SHOTS"
