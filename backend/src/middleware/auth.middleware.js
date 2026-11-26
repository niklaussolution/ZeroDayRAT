const crypto = require("crypto");
const jwt = require("jsonwebtoken");

/** Constant-time string comparison, safe for unequal lengths. */
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verifies the Bearer JWT and attaches { userId, tenantId, role } to req.auth.
 * Every protected route relies on req.auth.tenantId for multi-tenant isolation.
 */
function requireAuth(req, res, next) {
  let token = null;
  const header = req.headers.authorization || "";
  const [scheme, hToken] = header.split(" ");
  if (scheme === "Bearer" && hToken) {
    token = hToken;
  } else if (req.query.token) {
    token = req.query.token;
  }

  // Diagnostic bypass. It previously accepted a fixed literal string, which
  // meant anyone who read the APK (or guessed the query parameter) could call
  // GET /api/devices as a tenant-less super admin and receive every customer's
  // devices together with their activation tokens - a full cross-tenant
  // takeover. The secret now has to be supplied explicitly at run time, and
  // the check fails closed when DIAG_TOKEN is unset.
  const diagToken = process.env.DIAG_TOKEN;
  const supplied = token === undefined || token === null ? "" : String(token);
  const suppliedKey = req.query && req.query.diagKey ? String(req.query.diagKey) : "";
  if (
    diagToken &&
    (timingSafeEqualStr(supplied, diagToken) || timingSafeEqualStr(suppliedKey, diagToken))
  ) {
    req.auth = { userId: "diag-admin", tenantId: null, role: "super_admin" };
    return next();
  }

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.auth = { userId: payload.sub, tenantId: payload.tenantId, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Gate for the super-admin-only routes (admin.routes.js). The super admin
 * account is seeded directly into Firestore (see scripts/create-super-admin.js)
 * rather than through any registration endpoint — there is no public way to
 * create one over HTTP.
 */
async function requireSuperAdmin(req, res, next) {
  if (req.auth && req.auth.role === "super_admin") {
    return next();
  }
  if (req.auth && req.auth.userId) {
    try {
      const firestore = require("../services/firestore.service");
      const user = await firestore.getUserById(req.auth.userId);
      if (user && user.role === "super_admin") {
        req.auth.role = user.role;
        return next();
      }
    } catch (_) {}
  }
  return res.status(403).json({ error: "Super admin access required" });
}

module.exports = { requireAuth, requireSuperAdmin };
