/**
 * One-off seed script — creates (or updates the password of) the single
 * super admin account directly in Firestore via the Admin SDK. Deliberately
 * NOT an HTTP endpoint: there is no public way to create a super admin over
 * the network, only by running this script with access to the service
 * account credentials (local file or FIREBASE_SERVICE_ACCOUNT_JSON env var,
 * same as the running backend — see src/services/firebaseAdmin.js).
 *
 * Usage:
 *   node scripts/create-super-admin.js <email> <password>
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { syncClockSkew } = require("../src/services/clockSync");
const { getFirebaseAdmin } = require("../src/services/firebaseAdmin");

async function main() {
  await syncClockSkew();
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Usage: node scripts/create-super-admin.js <email> <password>");
    process.exit(1);
  }

  const admin = getFirebaseAdmin();
  if (!admin) {
    console.error("Firestore is not configured — missing service account credentials.");
    process.exit(1);
  }
  const db = admin.firestore();

  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await db.collection("users").where("email", "==", email).limit(1).get();

  if (!existing.empty) {
    const doc = existing.docs[0];
    await doc.ref.update({ passwordHash, role: "super_admin", tenantId: null });
    console.log(`Updated existing user ${email} (id ${doc.id}) to super_admin.`);
    return;
  }

  const id = crypto.randomUUID();
  await db.collection("users").doc(id).set({
    id,
    tenantId: null,
    email,
    passwordHash,
    fullName: "Super Admin",
    role: "super_admin",
    createdAt: new Date().toISOString(),
  });
  console.log(`Created super_admin user ${email} (id ${id}).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
