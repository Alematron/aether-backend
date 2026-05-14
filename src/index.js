require("dotenv").config();

const express = require("express");
const app = express();

const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");

const { connectDB } = require("./db/pool");
const { connectRedis } = require("./services/redis");

const logger = require("./utils/logger");
const errorHandler = require("./middleware/errorHandler");
const { globalRateLimit } = require("./middleware/rateLimiter");

// ─────────────────────────────────────────────────────────────
// REQUEST DEBUG (must be AFTER app init)
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log("REQ:", req.method, req.path);
  next();
});

// ─────────────────────────────────────────────────────────────
// CORS CONFIG
// ─────────────────────────────────────────────────────────────

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
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(null, false);
  },

  credentials: true,

  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  allowedHeaders: ["Content-Type", "Authorization"],

  optionsSuccessStatus: 200,
};

// ─────────────────────────────────────────────────────────────
// MUST BE FIRST MIDDLEWARE
// ─────────────────────────────────────────────────────────────
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ─────────────────────────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────────────────────────

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", process.env.R2_PUBLIC_URL],
        mediaSrc: ["'self'", process.env.R2_PUBLIC_URL],
      },
    },
  })
);

// ─────────────────────────────────────────────────────────────
// GENERAL MIDDLEWARE
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// ERROR HANDLER (MUST BE LAST)
// ─────────────────────────────────────────────────────────────

app.use(errorHandler);

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────

async function start() {
  try {
    await connectDB();
    await connectRedis();

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