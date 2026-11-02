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

# A fresh scenario: fixtures reset, a long refresh interval, no time limit override, a new
# extension instance, and its first refresh answered.
begin() {
    echo
    echo "== $1"
    fake_reset
    set_interval "${2:-60}"
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
begin "A refresh interval chosen in the preferences window survives a restart"
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
# Offsets of the Refresh interval row and of its "5 seconds" choice, in the default window.
pointer_click_at $((px + 515)) $((py + 137))
sleep 1
screenshot "$SHOTS/prefs-interval-open.png"
pointer_click_at $((px + 547)) $((py + 182))
sleep 1
check "choosing 5 seconds saves it at once" test "$(gsettings get "$HL_SCHEMA" refresh-interval)" = "uint32 5"
pointer_park
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.ScreenshotWindow true false false "$SHOTS/prefs.png" >/dev/null
shell_eval "$PREFS.delete(global.get_current_time()); 'ok'" >/dev/null
sleep 1
shell_restart
check "the interval is still 5 seconds after restarting the shell" \
    test "$(gsettings get "$HL_SCHEMA" refresh-interval)" = "uint32 5"
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
