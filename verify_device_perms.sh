#!/usr/bin/env bash
# Prints a pass/fail table of everything the provisioning chain is supposed to
# grant, straight from the device. Read-only: it only queries dumpsys/appops.
#
#   ./verify_device_perms.sh            # uses the single attached device
#   ./verify_device_perms.sh <serial>   # pick a device
#
# Exit code is the number of failing checks, so it can gate a test run.

set -uo pipefail

ADB="${ADB:-C:/Users/manib/AppData/Local/Android/Sdk/platform-tools/adb.exe}"
PKG="com.spapp.monitoring"
SERIAL="${1:-}"
A=("$ADB")
[ -n "$SERIAL" ] && A+=(-s "$SERIAL")

sh_() { "${A[@]}" shell "$@" 2>/dev/null | tr -d '\r'; }

if ! "${A[@]}" get-state >/dev/null 2>&1; then
  echo "No device. Connect it, enable USB debugging, accept the RSA prompt." >&2
  exit 99
fi

echo "=== DEVICE ==="
printf 'model   : %s\n' "$(sh_ getprop ro.product.model)"
printf 'brand   : %s\n' "$(sh_ getprop ro.product.brand)"
printf 'android : %s (SDK %s)\n' "$(sh_ getprop ro.build.version.release)" "$(sh_ getprop ro.build.version.sdk)"
printf 'oem skin: %s\n' "$(sh_ getprop ro.build.version.incremental)"

echo
echo "=== APP ==="
if ! "${A[@]}" shell pm list packages "$PKG" 2>/dev/null | grep -q "$PKG"; then
  echo "not installed: $PKG" >&2
  exit 98
fi
DUMP=$(sh_ dumpsys package "$PKG")
printf 'version : %s\n' "$(printf '%s\n' "$DUMP" | grep -m1 -o 'versionName=[^ ]*' | cut -d= -f2)"
printf 'code    : %s\n' "$(printf '%s\n' "$DUMP" | grep -m1 -o 'versionCode=[0-9]*' | cut -d= -f2)"
printf 'target  : %s\n' "$(printf '%s\n' "$DUMP" | grep -m1 -o 'targetSdk=[0-9]*' | cut -d= -f2)"

pass=0; fail=0
row() { # <label> <state> ; state: ok|FAIL|warn
  if [ "$2" = "ok" ]; then pass=$((pass+1)); printf '  [ OK ]  %s\n' "$1"
  elif [ "$2" = "warn" ]; then printf '  [ -- ]  %s\n' "$1"
  else fail=$((fail+1)); printf '  [FAIL]  %s\n' "$1"; fi
}

has_perm() { printf '%s\n' "$DUMP" | grep -q "android.permission.$1: granted=true"; }

echo
echo "=== RUNTIME ==="
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION ACCESS_BACKGROUND_LOCATION \
         CAMERA RECORD_AUDIO READ_CONTACTS READ_SMS READ_CALL_LOG; do
  if has_perm "$p"; then row "$p" ok; else row "$p" FAIL; fi
done
for p in READ_MEDIA_IMAGES READ_MEDIA_VIDEO READ_MEDIA_AUDIO READ_EXTERNAL_STORAGE \
         POST_NOTIFICATIONS; do
  if has_perm "$p"; then row "$p" ok; else row "$p" warn; fi
done

echo
echo "=== SPECIAL ACCESS ==="
A11Y=$(sh_ settings get secure enabled_accessibility_services)
case "$A11Y" in *"$PKG"*) row "Accessibility service" ok ;; *) row "Accessibility service" FAIL ;; esac

NOTIF=$(sh_ settings get secure enabled_notification_listeners)
case "$NOTIF" in *"$PKG"*) row "Notification listener" ok ;; *) row "Notification listener" FAIL ;; esac

USAGE=$(sh_ appops get "$PKG" GET_USAGE_STATS)
case "$USAGE" in *allow*) row "Usage access" ok ;; *) row "Usage access" FAIL ;; esac

FILES=$(sh_ appops get "$PKG" MANAGE_EXTERNAL_STORAGE)
case "$FILES" in *allow*) row "All files access" ok ;; *) row "All files access" FAIL ;; esac

DOZE=$(sh_ dumpsys deviceidle whitelist | grep -c "$PKG")
[ "$DOZE" -gt 0 ] && row "Battery exemption" ok || row "Battery exemption" FAIL

if sh_ dumpsys device_policy | grep -q "$PKG"; then row "Device admin" ok; else row "Device admin" FAIL; fi

echo
echo "=== ROLES (SMS / Phone) ==="
if [ "$(sh_ getprop ro.build.version.sdk)" -ge 29 ]; then
  SMSR=$(sh_ cmd role get-role-holders android.app.role.SMS)
  case "$SMSR" in *"$PKG"*) row "Default SMS role (=> READ_SMS)" ok ;; *) row "Default SMS role (=> READ_SMS)" warn ;; esac
  DIALR=$(sh_ cmd role get-role-holders android.app.role.DIALER)
  case "$DIALR" in *"$PKG"*) row "Default Phone role (=> READ_CALL_LOG)" ok ;; *) row "Default Phone role (=> READ_CALL_LOG)" warn ;; esac
else
  row "RoleManager" warn
fi

echo
echo "=== RESULT: $pass passed, $fail failed ==="
exit "$fail"
