const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  // Multer errors (file upload)
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large. Max ${process.env.MAX_UPLOAD_SIZE_MB || 50}MB.` });
  }
  if (err.message?.startsWith("Unsupported file type")) {
    return res.status(415).json({ error: err.message });
  }

  // Postgres unique violation
  if (err.code === "23505") {
    return res.status(409).json({ error: "Already exists" });
  }

  // Postgres foreign key violation
  if (err.code === "23503") {
    return res.status(400).json({ error: "Referenced resource not found" });
  }

  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : "Internal server error";

  if (status >= 500) {
    logger.error(`${req.method} ${req.path} — ${err.message}`, { stack: err.stack });
  }

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
