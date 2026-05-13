const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");

const { query, transaction } = require("../db/pool");
const { authRateLimit } = require("../middleware/rateLimiter");
const { authenticate } = require("../middleware/authenticate");
const logger = require("../utils/logger");

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────

function signAccessToken(userId) {
  return jwt.sign({ sub: userId, type: "access" }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  });
}

function signRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: "refresh" }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
  });
}

// Hash an email so we can check uniqueness without storing plaintext
function hashEmail(email) {
  return crypto.createHmac("sha256", process.env.JWT_SECRET)
    .update(email.toLowerCase().trim())
    .digest("hex");
}

// Extract a privacy-safe device hint from the request
function deviceHint(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  const ua = req.headers["user-agent"] || "";
  // Deliberately vague — just enough for the user to recognise the session
  const browser = ua.includes("Chrome") ? "Chrome" :
                  ua.includes("Firefox") ? "Firefox" :
                  ua.includes("Safari") ? "Safari" : "Browser";
  return `${browser} · ${ip.slice(0, ip.lastIndexOf(".") + 1)}xxx`;
}

// ── POST /api/auth/register ────────────────────────────────────────────────
router.post("/register",
  authRateLimit,
  [
    body("handle")
      .trim()
      .matches(/^[a-z0-9_]{3,32}$/)
      .withMessage("Handle must be 3–32 lowercase letters, numbers, or underscores"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("email")
      .optional({ nullable: true, checkFalsy: true })
      .isEmail()
      .normalizeEmail(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { handle, password, email } = req.body;

      // Check handle uniqueness
      const existing = await query("SELECT id FROM users WHERE handle = $1", [handle]);
      if (existing.rows.length) {
        return res.status(409).json({ error: "Handle already taken" });
      }

      // Check email uniqueness (if provided) without storing it plaintext
      let emailHash = null;
      if (email) {
        emailHash = hashEmail(email);
        const emailExists = await query(
          "SELECT id FROM users WHERE email_hash = $1", [emailHash]
        );
        if (emailExists.rows.length) {
          return res.status(409).json({ error: "Account already exists for that email" });
        }
      }

      const rounds = parseInt(process.env.BCRYPT_ROUNDS || "12");
      const passwordHash = await bcrypt.hash(password, rounds);

      const { rows } = await query(
        `INSERT INTO users (handle, password_hash, email_hash)
         VALUES ($1, $2, $3)
         RETURNING id, handle, created_at`,
        [handle, passwordHash, emailHash]
      );

      const user = rows[0];
      const accessToken = signAccessToken(user.id);
      const refreshToken = signRefreshToken(user.id);

      // Store hashed refresh token
      const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, device_hint, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [user.id, tokenHash, deviceHint(req), expiresAt]
      );

      logger.info(`New user registered: @${handle}`);

      res.status(201).json({
        user: { id: user.id, handle: user.handle },
        accessToken,
        refreshToken,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post("/login",
  authRateLimit,
  [
    body("handle").trim().notEmpty(),
    body("password").notEmpty(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { handle, password } = req.body;

      const { rows } = await query(
        `SELECT id, handle, password_hash, is_active, is_banned, ban_reason
         FROM users WHERE handle = $1`,
        [handle]
      );

      // Constant-time response to prevent user enumeration
      const user = rows[0];
      const hashToCheck = user?.password_hash || "$2b$12$invalidhashfortimingnormalization";
      const valid = await bcrypt.compare(password, hashToCheck);

      if (!user || !valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      if (!user.is_active || user.is_banned) {
        return res.status(403).json({ error: "Account suspended", reason: user.ban_reason });
      }

      const accessToken = signAccessToken(user.id);
      const refreshToken = signRefreshToken(user.id);

      const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await transaction(async (client) => {
        // Limit to 5 active sessions per user — evict oldest
        const sessions = await client.query(
          `SELECT id FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
          [user.id]
        );
        if (sessions.rows.length >= 5) {
          const toDelete = sessions.rows.slice(4).map(r => r.id);
          await client.query(`DELETE FROM refresh_tokens WHERE id = ANY($1)`, [toDelete]);
        }
        await client.query(
          `INSERT INTO refresh_tokens (user_id, token_hash, device_hint, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [user.id, tokenHash, deviceHint(req), expiresAt]
        );
        await client.query(
          `UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [user.id]
        );
      });

      res.json({
        user: { id: user.id, handle: user.handle },
        accessToken,
        refreshToken,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/refresh ─────────────────────────────────────────────────
router.post("/refresh", authRateLimit, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: "No refresh token" });

    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    if (payload.type !== "refresh") {
      return res.status(401).json({ error: "Wrong token type" });
    }

    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const { rows } = await query(
      `SELECT rt.id, rt.user_id, u.is_active, u.is_banned
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.expires_at > NOW()`,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(401).json({ error: "Session expired or revoked" });
    }

    const { user_id, is_active, is_banned } = rows[0];
    if (!is_active || is_banned) {
      return res.status(403).json({ error: "Account suspended" });
    }

    // Rotate: delete old token, issue new pair
    const newAccess = signAccessToken(user_id);
    const newRefresh = signRefreshToken(user_id);
    const newHash = crypto.createHash("sha256").update(newRefresh).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await transaction(async (client) => {
      await client.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [tokenHash]);
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, device_hint, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [user_id, newHash, deviceHint(req), expiresAt]
      );
    });

    res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────
router.post("/logout", authenticate, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      await query(`DELETE FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2`,
        [tokenHash, req.user.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/sessions ─────────────────────────────────────────────────
router.get("/sessions", authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, device_hint, created_at, expires_at
       FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/auth/sessions/:id ─────────────────────────────────────────
router.delete("/sessions/:id", authenticate, async (req, res, next) => {
  try {
    await query(
      `DELETE FROM refresh_tokens WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
