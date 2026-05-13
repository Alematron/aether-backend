const express = require("express");
const { query } = require("../db/pool");
const { authenticate, optionalAuth } = require("../middleware/authenticate");
const { findSimilarUsers } = require("../services/recommender");

const router = express.Router();

// ── GET /api/discover/aesthetics ───────────────────────────────────────────
router.get("/aesthetics", optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT unnest(aesthetics) AS aesthetic, COUNT(*) AS post_count
       FROM posts
       WHERE is_hidden = false AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY aesthetic
       ORDER BY post_count DESC
       LIMIT 30`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/discover/tags ─────────────────────────────────────────────────
router.get("/tags", optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT unnest(tags) AS tag, COUNT(*) AS post_count
       FROM posts
       WHERE is_hidden = false AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY tag
       ORDER BY post_count DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/discover/search ───────────────────────────────────────────────
router.get("/search", optionalAuth, async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim().slice(0, 100);
    if (!q) return res.status(400).json({ error: "Query required" });

    const type = req.query.type || "all";  // all|posts|users|communities

    const results = {};

    if (type === "all" || type === "posts") {
      const { rows } = await query(
        `SELECT p.*, u.handle, u.display_name, u.avatar_key
         FROM posts p JOIN users u ON u.id = p.user_id
         WHERE p.is_hidden = false AND p.visibility = 'public'
           AND (p.content ILIKE $1 OR $2 = ANY(p.tags) OR $2 = ANY(p.aesthetics))
         ORDER BY p.score DESC LIMIT 20`,
        [`%${q}%`, q.toLowerCase()]
      );
      results.posts = rows;
    }

    if (type === "all" || type === "users") {
      const { rows } = await query(
        `SELECT id, handle, display_name, bio, avatar_key, follower_count
         FROM users
         WHERE is_active=true AND is_banned=false
           AND (handle ILIKE $1 OR display_name ILIKE $1)
         ORDER BY follower_count DESC LIMIT 10`,
        [`%${q}%`]
      );
      results.users = rows;
    }

    if (type === "all" || type === "communities") {
      const { rows } = await query(
        `SELECT id, slug, name, description, icon, member_count, aesthetics
         FROM communities
         WHERE visibility='public'
           AND (name ILIKE $1 OR slug ILIKE $1 OR $2 = ANY(aesthetics))
         ORDER BY member_count DESC LIMIT 10`,
        [`%${q}%`, q.toLowerCase()]
      );
      results.communities = rows;
    }

    res.json(results);
  } catch (err) { next(err); }
});

// ── GET /api/discover/suggested-users ─────────────────────────────────────
router.get("/suggested-users", authenticate, async (req, res, next) => {
  try {
    const users = await findSimilarUsers(req.user.id, 10);
    res.json(users);
  } catch (err) { next(err); }
});

module.exports = router;
