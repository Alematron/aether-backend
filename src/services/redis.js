const Redis = require("ioredis");
const logger = require("../utils/logger");

let redisClient;

async function connectRedis() {
  if (!process.env.REDIS_URL) {
    logger.warn("REDIS_URL not set — running without cache (degraded performance)");
    return;
  }
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  redisClient.on("error", (err) => logger.warn("Redis error:", err.message));
  await redisClient.connect();
  logger.info("Redis connected");
}

function getRedis() {
  return redisClient || null;
}

module.exports = { connectRedis, getRedis };