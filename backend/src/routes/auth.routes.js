const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const firestore = require("../services/firestore.service");
const { requireAuth, requireSuperAdmin } = require("../middleware/auth.middleware");

const router = express.Router();

/**
 * POST /api/auth/register
 * Creates a brand-new tenant (family or company) + its first owner user.
 * RESTRICTED: Only Super Admin can create/register new tenants.
 */
router.post(
  "/register",
  requireAuth,
  requireSuperAdmin,
  [
    body("tenantName").isString().trim().isLength({ min: 2 }),
    body("tenantType").isIn(["family", "company"]),
    body("email").isEmail().normalizeEmail(),
    body("password").isString().isLength({ min: 8 }),
    body("fullName").optional().isString().trim(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Validation failed", details: errors.array() });
    }

    const { tenantName, tenantType, email, password, fullName } = req.body;

    try {
      const existing = await firestore.findUserByEmail(email);
      if (existing) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const tenant = await firestore.createTenant({ name: tenantName, type: tenantType });

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await firestore.createUser({
        tenantId: tenant.id,
        email,
        passwordHash,
        fullName,
        role: "owner",
      });

      const token = jwt.sign(
        { sub: user.id, tenantId: tenant.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      res.status(201).json({
        token,
        tenant: { id: tenant.id, name: tenant.name, type: tenant.type, created_at: tenant.createdAt },
        user: { id: user.id, email: user.email, full_name: user.fullName, role: user.role, created_at: user.createdAt },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/auth/login
 */
router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").isString().notEmpty()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Validation failed", details: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const user = await firestore.findUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const passwordMatches = await bcrypt.compare(password, user.passwordHash);
      if (!passwordMatches) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // The super admin account has no tenantId — it isn't scoped to any
      // one tenant, so there's nothing to look up here (see admin.routes.js
      // for what it can actually do).
      const tenant = user.role === "super_admin" ? null : await firestore.getTenant(user.tenantId);

      const token = jwt.sign(
        { sub: user.id, tenantId: user.tenantId || null, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          tenantId: user.tenantId || null,
          tenantName: tenant?.name || null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
