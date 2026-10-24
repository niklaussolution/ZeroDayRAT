# APK download

`ConnectPage.tsx`'s "Download App" button links to `/download/spapp-monitor.apk`
(served statically by Vercel from this folder, same domain as the dashboard).

After every build you want the new-device link to install, copy the signed
release APK here with exactly this name, commit it, and push:

```
cp android-app/app/build/outputs/apk/release/app-release.apk dashboard/public/download/spapp-monitor.apk
git add dashboard/public/download/spapp-monitor.apk
git commit -m "Update distributed APK"
git push
```

Vercel will redeploy automatically and the link will serve the new file.
