const path = require("path");
const fs = require("fs");

let firebaseAdmin = null;
let initAttempted = false;

/**
 * Shared firebase-admin app initialization, used by both fcm.service.js
 * (push notifications) and firestore.service.js (admin/user accounts).
 * Tries three sources, in order, so the same code works in local dev and
 * on a cloud host without a filesystem-upload step:
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON env var — the whole key file's JSON
 *      pasted as one env var value (works on any host, incl. Render).
 *   2. backend/firebase-service-account.json — local dev (gitignored).
 *   3. /etc/secrets/firebase-service-account.json — Render's "Secret Files"
 *      mount path, if used instead of the env var.
 * Throws when a caller actually needs Firestore and none of these are
 * present — unlike FCM, there is no "skip gracefully" fallback for auth data.
 */
function getFirebaseAdmin() {
  if (initAttempted) return firebaseAdmin;
  initAttempted = true;

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    console.warn(
      "[firebase] No Firebase credentials found (checked FIREBASE_SERVICE_ACCOUNT_JSON env var, " +
        "backend/firebase-service-account.json, and /etc/secrets/firebase-service-account.json) — " +
        "Firestore and FCM push are both unavailable."
    );
    return null;
  }

  try {
    const { syncClockSkew } = require("./clockSync");
    syncClockSkew();
    const admin = require("firebase-admin");
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseAdmin = admin;
    console.log("[firebase] firebase-admin initialized.");
  } catch (err) {
    console.error("[firebase] Failed to initialize firebase-admin:", err.message);
    firebaseAdmin = null;
  }

  return firebaseAdmin;
}

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      console.error("[firebase] FIREBASE_SERVICE_ACCOUNT_JSON is set but not valid JSON:", err.message);
    }
  }

  const candidatePaths = [
    path.join(__dirname, "..", "..", "firebase-service-account.json"),
    "/etc/secrets/firebase-service-account.json",
  ];
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf8"));
      } catch (err) {
        console.error(`[firebase] Failed to parse ${candidate}:`, err.message);
      }
    }
  }

  return null;
}

module.exports = { getFirebaseAdmin };
