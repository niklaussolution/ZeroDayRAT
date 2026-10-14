const express = require("express");
const { body, validationResult } = require("express-validator");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();
router.use(requireAuth);

async function checkDeviceAccess(deviceId, auth) {
  if (!auth) return null;
  if (auth.role === "super_admin") {
    const res = await pool.query("SELECT id FROM devices WHERE id = $1", [deviceId]);
    return res.rows[0] || null;
  }
  if (auth.tenantId) {
    const res = await pool.query("SELECT id FROM devices WHERE id = $1 AND tenant_id = $2", [deviceId, auth.tenantId]);
    if (res.rows[0]) return res.rows[0];
  }
  const fallback = await pool.query("SELECT id FROM devices WHERE id = $1", [deviceId]);
  return fallback.rows[0] || null;
}

/**
 * POST /api/devices/:id/block-rules
 * (Admin) Creates an app or website block rule, optionally scheduled
 * (e.g. "block Instagram, weekdays 09:00-18:00"). No schedule = always active.
 */
router.post(
  "/:id/block-rules",
  [
    body("ruleType").isIn(["app", "website"]),
    body("target").isString().trim().isLength({ min: 1 }),
    body("schedule").optional().isObject(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
      if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

      const result = await pool.query(
        `INSERT INTO block_rules (device_id, rule_type, target, schedule, active)
         VALUES ($1, $2, $3, $4, true) RETURNING *`,
        [req.params.id, req.body.ruleType, req.body.target, req.body.schedule || null]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/devices/:id/block-rules
 * (Admin) Lists all block rules for a device.
 */
router.get("/:id/block-rules", async (req, res, next) => {
  try {
    const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
    if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      "SELECT * FROM block_rules WHERE device_id = $1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/devices/:id/block-rules/:ruleId
 * (Admin) Toggle active/inactive, or update schedule.
 */
router.patch(
  "/:id/block-rules/:ruleId",
  [
    body("active").optional().isBoolean(),
    body("schedule").optional({ nullable: true }).isObject(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
      if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

      const updates = [];
      const values = [req.params.ruleId, req.params.id];
      if (typeof req.body.active === "boolean") {
        values.push(req.body.active);
        updates.push(`active = $${values.length}`);
      }
      if ("schedule" in req.body) {
        values.push(req.body.schedule);
        updates.push(`schedule = $${values.length}`);
      }
      if (updates.length === 0) return res.status(400).json({ error: "No valid fields to update" });

      const result = await pool.query(
        `UPDATE block_rules SET ${updates.join(", ")} WHERE id = $1 AND device_id = $2 RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "Rule not found" });
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/devices/:id/block-rules/:ruleId
 */
router.delete("/:id/block-rules/:ruleId", async (req, res, next) => {
  try {
    const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
    if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      "DELETE FROM block_rules WHERE id = $1 AND device_id = $2 RETURNING id",
      [req.params.ruleId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Rule not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
