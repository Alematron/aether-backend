const rateLimit = require("express-rate-limit");

const globalRateLimit = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"),
  max: parseInt(process.env.RATE_LIMIT_MAX || "100"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
  skip: (req) => req.path === "/health",
});

// Tighter limit for auth endpoints — prevents brute-force
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "10"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Try again in 15 minutes." },
});

// For media uploads
const uploadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 50,
  message: { error: "Upload limit reached. Try again in an hour." },
});

module.exports = { globalRateLimit, authRateLimit, uploadRateLimit };
