const crypto = require("crypto");
const { getFirebaseAdmin } = require("./firebaseAdmin");

/**
 * Admin accounts (tenants + users) live in Firestore — devices, logs,
 * feature flags, and everything else stay in Postgres (see schema.sql).
 * IDs are generated as UUIDs (not Firestore auto-IDs) so they stay
 * compatible with the existing `devices.tenant_id UUID` column in Postgres,
 * which no longer has a foreign key to a Postgres `tenants` table — Firestore
 * is now the source of truth for tenant/user existence.
 */
function db() {
  const admin = getFirebaseAdmin();
  if (!admin) {
    const err = new Error(
      "Firestore is not configured — backend/firebase-service-account.json is missing. " +
        "Admin accounts (register/login) cannot work without it."
    );
    err.status = 503;
    throw err;
  }
  return admin.firestore();
}

const TENANTS = "tenants";
const USERS = "users";

async function createTenant({ name, type }) {
  const id = crypto.randomUUID();
  const tenant = { id, name, type, createdAt: new Date().toISOString() };
  await db().collection(TENANTS).doc(id).set(tenant);
  return tenant;
}

async function getTenant(id) {
  const snap = await db().collection(TENANTS).doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function findUserByEmail(email) {
  const snap = await db().collection(USERS).where("email", "==", email).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}

async function getUserById(id) {
  const snap = await db().collection(USERS).doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function createUser({ tenantId, email, passwordHash, plainPassword, fullName, role }) {
  const id = crypto.randomUUID();
  const user = {
    id,
    tenantId,
    email,
    passwordHash,
    plainPassword: plainPassword || null,
    fullName: fullName || null,
    role,
    createdAt: new Date().toISOString(),
  };
  await db().collection(USERS).doc(id).set(user);
  return user;
}

async function updateUserPassword(id, passwordHash, plainPassword) {
  const updates = {
    passwordHash,
    plainPassword: plainPassword || null,
    updatedAt: new Date().toISOString(),
  };
  await db().collection(USERS).doc(id).update(updates);
}

async function listUsersByTenant(tenantId) {
  const snap = await db().collection(USERS).where("tenantId", "==", tenantId).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
}

/** Super-admin only — every tenant that's ever registered. */
async function listAllTenants() {
  const snap = await db().collection(TENANTS).get();
  return snap.docs.map((d) => d.data());
}

/** Super-admin only — every registered admin login, across all tenants. */
async function listAllUsers() {
  const snap = await db().collection(USERS).get();
  return snap.docs.map((d) => d.data());
}

async function deleteUser(id) {
  await db().collection(USERS).doc(id).delete();
}

async function deleteTenant(id) {
  await db().collection(TENANTS).doc(id).delete();
}

module.exports = {
  createTenant,
  getTenant,
  findUserByEmail,
  getUserById,
  createUser,
  updateUserPassword,
  listUsersByTenant,
  listAllTenants,
  listAllUsers,
  deleteUser,
  deleteTenant,
};
