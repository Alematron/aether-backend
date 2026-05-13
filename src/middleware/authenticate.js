const jwt = require("jsonwebtoken");
const { query } = require("../db/pool");

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }

  if (payload.type !== "access") {
    return res.status(401).json({ error: "Wrong token type" });
  }

  const { rows } = await query(
    `SELECT id, handle, role, is_active, is_banned, hide_activity
     FROM users WHERE id = $1`,
    [payload.sub]
  );

  if (!rows.length || !rows[0].is_active || rows[0].is_banned) {
    return res.status(403).json({ error: "Account suspended or not found" });
  }

  req.user = rows[0];
  next();
}

// Use when auth is optional (public routes that show more if logged in)
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type === "access") {
      const { rows } = await query(
        `SELECT id, handle, role FROM users WHERE id = $1 AND is_active = true`,
        [payload.sub]
      );
      if (rows.length) req.user = rows[0];
    }
  } catch {}
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

module.exports = { authenticate, optionalAuth, requireRole };
