const express = require("express");
const { authenticate, optionalAuth } = require("../middleware/authenticate");
const { buildFeed } = require("../services/recommender");
const { getRedis } = require("../services/redis");

const router = express.Router();

// GET /api/feed?type=foryou&page=0
router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const feedType = ["foryou", "following", "trending", "remixes"].includes(req.query.type)
      ? req.query.type : "foryou";
    const page = Math.max(0, parseInt(req.query.page || "0"));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "20")));

    if (feedType === "following" && !req.user) {
      return res.status(401).json({ error: "Login required for following feed" });
    }

    const userId = req.user?.id || "00000000-0000-0000-0000-000000000000";

    // Cache key — don't cache personalized feeds beyond page 0
    const cacheKey = `feed:${feedType}:${userId}:${page}`;
    const redis = getRedis();
    if (redis && page < 3) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const posts = await buildFeed(userId, feedType, page, limit);

    if (redis && page < 3) {
      const ttl = feedType === "trending" ? 300 : 120; // trending: 5min, personal: 2min
      await redis.setex(cacheKey, ttl, JSON.stringify(posts));
    }

    res.json({ posts, page, feedType, hasMore: posts.length === limit });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
