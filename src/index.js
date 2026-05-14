require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");

const { connectDB } = require("./db/pool");
const { connectRedis } = require("./services/redis");
const logger = require("./utils/logger");
const errorHandler = require("./middleware/errorHandler");
const { globalRateLimit } = require("./middleware/rateLimiter");

// Routes
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const postRoutes = require("./routes/posts");
const feedRoutes = require("./routes/feed");
const communityRoutes = require("./routes/communities");
const mediaRoutes = require("./routes/media");
const remixRoutes = require("./routes/remixes");
const discoverRoutes = require("./routes/discover");

const app = express();
const express = require("express");

const app = express();

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://blueroom.club"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  next();
});

app.use(express.json());
app.options("*", (req, res) => {
  res.sendStatus(200);
});
// ─── CORS (must be first) ──────────────────────────────────────────────────
const corsOptions = {
  origin: function(origin, callback) {
    const allowed = [
      'https://blueroom.club',
      'https://www.blueroom.club',
      'http://localhost:3000',
      process.env.FRONTEND_URL,
    ].filter(Boolean)
    if (!origin || allowed.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
}

app.options('*', cors(corsOptions))
app.use(cors(corsOptions))

// ─── Security Middleware ───────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", process.env.R2_PUBLIC_URL],
      mediaSrc: ["'self'", process.env.R2_PUBLIC_URL],
    },
  },
}));

app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(morgan("combined", { stream: { write: (msg) => logger.http(msg.trim()) } }));
app.use(globalRateLimit);

// ─── Health Check ─────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "aether-api", timestamp: new Date().toISOString() });
});

// ─── API Routes ───────────────────────────────────────────────────────────
app.use("/api/auth",        authRoutes);
app.use("/api/users",       userRoutes);
app.use("/api/posts",       postRoutes);
app.use("/api/feed",        feedRoutes);
app.use("/api/communities", communityRoutes);
app.use("/api/media",       mediaRoutes);
app.use("/api/remixes",     remixRoutes);
app.use("/api/discover",    discoverRoutes);

// ─── Error Handler (must be last) ─────────────────────────────────────────
app.use(errorHandler);

// ─── Boot ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    await connectDB();
    await connectRedis();
    const port = process.env.PORT || 3000;
    app.listen(port, () => logger.info(`ÆTHER API running on port ${port}`));
  } catch (err) {
    logger.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();