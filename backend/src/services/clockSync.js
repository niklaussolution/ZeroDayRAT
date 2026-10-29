const https = require("https");

let clockSynced = false;

/**
 * Checks for system clock skew against Google's servers.
 * If local time has a skew (e.g. 12-hour AM/PM flip or incorrect RTC),
 * transparently compensates Date so Firebase Admin SDK, JWTs, and OAuth2
 * requests do not get rejected by Google with `invalid_grant (16 UNAUTHENTICATED)`.
 */
function syncClockSkew() {
  if (clockSynced) return Promise.resolve();

  return new Promise((resolve) => {
    const req = https.get("https://www.google.com", { timeout: 3500 }, (res) => {
      const serverDate = res.headers.date;
      if (serverDate) {
        const googleTime = new Date(serverDate).getTime();
        const localTime = Date.now();
        const diffMs = googleTime - localTime;

        if (Math.abs(diffMs) > 60_000) {
          console.warn(
            `[clockSync] System clock has a ${(diffMs / 3600000).toFixed(2)}h skew against Google. Applying automatic compensation.`
          );
          const OrigDate = Date;
          function PatchedDate(...args) {
            if (args.length === 0) {
              return new OrigDate(OrigDate.now() + diffMs);
            }
            return new OrigDate(...args);
          }
          PatchedDate.now = () => OrigDate.now() + diffMs;
          PatchedDate.parse = OrigDate.parse;
          PatchedDate.UTC = OrigDate.UTC;
          PatchedDate.prototype = OrigDate.prototype;
          global.Date = PatchedDate;
        } else {
          console.log("[clockSync] System clock is synchronized with Google servers.");
        }
      }
      clockSynced = true;
      resolve();
    });

    req.on("error", (err) => {
      console.warn("[clockSync] Could not reach Google time server to check clock skew:", err.message);
      clockSynced = true;
      resolve();
    });

    req.on("timeout", () => {
      req.destroy();
      clockSynced = true;
      resolve();
    });
  });
}

module.exports = { syncClockSkew };

