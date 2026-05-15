require("dotenv").config();

const express = require("express");
const app = express();
app.set('trust proxy', 1);

const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");

const logger = require("./utils/logger");
const errorHandler = require("./middleware/errorHandler");
const { globalRateLimit } = require("./middleware/rateLimiter");

// ─────────────────────────────────────────────
// DEBUG (FIRST)
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    console.log("🔥 OPTIONS:", req.path);
  }
  next();
});

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────

const allowedOrigins = [
  "https://blueroom.club",
  "https://www.blueroom.club",
  "http://localhost:3000",
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

const corsOptions = {
  origin: (origin, callback) => {
    console.log("CORS origin:", origin);

    if (!origin) return callback(null, true);

    const cleanOrigin = origin.replace(/\/$/, "");

    if (allowedOrigins.includes(cleanOrigin)) {
      return callback(null, true);
    }

    // TEMP SAFE MODE (prevents CORS deadlocks)
    return callback(null, true);
  },

  credentials: true,

  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  allowedHeaders: ["Content-Type", "Authorization"],
};

// ─────────────────────────────────────────────
// CORS MUST BE FIRST MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors(corsOptions));

// IMPORTANT: Render-safe OPTIONS handler
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  return res.sendStatus(204);
});

// ─────────────────────────────────────────────
// SECURITY + CORE MIDDLEWARE
// ─────────────────────────────────────────────

app.use(helmet());

app.use(compression());

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(
  morgan("combined", {
    stream: {
      write: (msg) => logger.http(msg.trim()),
    },
  })
);

app.use(globalRateLimit);

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const postRoutes = require("./routes/posts");
const feedRoutes = require("./routes/feed");
const communityRoutes = require("./routes/communities");
const mediaRoutes = require("./routes/media");
const remixRoutes = require("./routes/remixes");
const discoverRoutes = require("./routes/discover");

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "aether-api",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/feed", feedRoutes);
app.use("/api/communities", communityRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/remixes", remixRoutes);
app.use("/api/discover", discoverRoutes);

// ─────────────────────────────────────────────
// ERROR HANDLER (LAST)
// ─────────────────────────────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

async function start() {
  try {
    // TEMP: disabled for debugging CORS/503
    // await connectDB();
    // await connectRedis();

    const port = process.env.PORT || 3000;

    app.listen(port, "0.0.0.0", () => {
      logger.info(`ÆTHER API running on port ${port}`);
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    logger.error("Failed to start server:", err);
    console.error(err);
    process.exit(1);
  }
}

start();