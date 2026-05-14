const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') 
    ? { rejectUnauthorized: false }
    : process.env.NODE_ENV === "production" 
      ? { rejectUnauthorized: false } 
      : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error:", err);
});

async function connectDB() {
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();
  logger.info("PostgreSQL connected");
}

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === "development" && duration > 100) {
    logger.warn(`Slow query (${duration}ms): ${text.slice(0, 80)}`);
  }
  return result;
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, transaction, connectDB };