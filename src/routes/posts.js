const express = require("express");
const { body, query: qv, param, validationResult } = require("express-validator");
const { query, transaction } = require("../db/pool");
const { authenticate, optionalAuth } = require("../middleware/authenticate");
const { getRedis } = require("../services/redis");
const { scorePost } = require("../services/recommender");

const router = express.Router();

// ── GET /api/posts/:id ─────────────────────────────────────────────────────
router.get("/:id", optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*,
              u.handle, u.display_name, u.avatar_key, u.badge,
              op.content AS original_content,
              ou.handle  AS original_handle
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN posts op ON op.id = p.original_post_id
       LEFT JOIN users ou ON ou.id = op.user_id
       WHERE p.id = $1 AND p.is_hidden = false`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Post not found" });

    // Track view (fire-and-forget)
    query(`UPDATE posts SET view_count = view_count + 1 WHERE id = $1`, [req.params.id])
      .catch(() => {});

    // Add viewer's interaction state
    let viewerState = { liked: false, reposted: false };
    if (req.user) {
      const [likeRow, repostRow] = await Promise.all([
        query(`SELECT 1 FROM likes WHERE user_id=$1 AND post_id=$2`, [req.user.id, req.params.id]),
        query(`SELECT 1 FROM reposts WHERE user_id=$1 AND post_id=$2`, [req.user.id, req.params.id]),
      ]);
      viewerState = { liked: !!likeRow.rows.length, reposted: !!repostRow.rows.length };
    }

    res.json({ ...rows[0], viewerState });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/posts ────────────────────────────────────────────────────────
router.post("/",
  authenticate,
  [
    body("content").optional().isString().isLength({ max: 2000 }),
    body("postType").isIn(["text", "image", "audio", "video", "collage"]),
    body("visibility").optional().isIn(["public", "followers", "community", "private"]),
    body("tags").optional().isArray({ max: 10 }),
    body("aesthetics").optional().isArray({ max: 5 }),
    body("mediaKeys").optional().isArray({ max: 10 }),
    body("communityId").optional().isUUID(),
    body("isNsfw").optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const {
        content, postType = "text", visibility = "public",
        tags = [], aesthetics = [], mediaKeys = [], mediaMeta = {},
        communityId, isNsfw = false,
      } = req.body;

      if (!content && !mediaKeys.length) {
        return res.status(400).json({ error: "Post must have content or media" });
      }

      router.post("/",
  authenticate,
  [
    body("content").optional().isString().isLength({ max: 2000 }),
    body("postType").optional().isIn(["text", "image", "audio", "video", "collage"]),
    body("visibility").optional().isIn(["public", "followers", "community", "private"]),
    body("tags").optional().isArray({ max: 10 }),
    body("aesthetics").optional().isArray({ max: 5 }),
    body("mediaKeys").optional().isArray({ max: 10 }),
    body("communityId").optional().isUUID(),
    body("isNsfw").optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const {
        content,
        postType = "text",
        visibility = "public",
        tags = [],
        aesthetics = [],
        mediaKeys = [],
        mediaMeta = {},
        communityId = null,
        isNsfw = false,
      } = req.body;

      if (!content && !mediaKeys.length) {
        return res.status(400).json({ error: "Post must have content or media" });
      }

      const result = await query(
        `INSERT INTO posts
           (user_id, content, post_type, visibility, tags, aesthetics,
            media_keys, media_meta, community_id, is_nsfw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [req.user.id, content, postType, visibility,
         tags, aesthetics, mediaKeys, mediaMeta, communityId, isNsfw]
      );

      const post = result.rows[0];

      await query(
        `UPDATE users SET post_count = post_count + 1 WHERE id = $1`,
        [req.user.id]
      );

      if (communityId) {
        await query(
          `UPDATE communities SET post_count = post_count + 1 WHERE id = $1`,
          [communityId]
        ).catch(() => {});
      }

      scorePost(post).catch(() => {});

      res.status(201).json(post);
    } catch (err) {
      next(err);
    }
  }
);

      // Async: compute initial score & fan out to followers' feeds
      scorePost(rows[0]).catch(() => {});

      // Update aesthetic scores for the author
      updateUserAesthetics(req.user.id, aesthetics, 1.0).catch(() => {});

      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);
// ── PATCH /api/posts/:id ───────────────────────────────────────────────────
router.patch("/:id",
  authenticate,
  [
    body("content").optional().isString().isLength({ max: 2000 }),
    body("tags").optional().isArray({ max: 10 }),
    body("mediaKeys").optional().isArray({ max: 10 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { rows } = await query(
        'SELECT user_id FROM posts WHERE id = $1', [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      if (rows[0].user_id !== req.user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { content, tags, mediaKeys } = req.body;
      const updates = [];
      const values = [];
      let i = 1;

      if (content !== undefined) { updates.push('content = $' + i++); values.push(content); }
      if (tags !== undefined) { updates.push('tags = $' + i++); values.push(tags); }
      if (mediaKeys !== undefined) { updates.push('media_keys = $' + i++); values.push(mediaKeys); }

      if (!updates.length) return res.status(400).json({ error: "Nothing to update" });

      values.push(req.params.id);
      const { rows: updated } = await query(
        'UPDATE posts SET ' + updates.join(', ') + ' WHERE id = $' + i + ' RETURNING *',
        values
      );

      res.json(updated[0]);
    } catch (err) {
      next(err);
    }
  }
);
// ── DELETE /api/posts/:id ──────────────────────────────────────────────────
router.delete("/:id", authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT user_id FROM posts WHERE id = $1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    if (rows[0].user_id !== req.user.id && req.user.role === "user") {
      return res.status(403).json({ error: "Forbidden" });
    }
    await transaction(async (client) => {
      await client.query(`DELETE FROM posts WHERE id = $1`, [req.params.id]);
      await client.query(
        `UPDATE users SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1`,
        [rows[0].user_id]
      );
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
// ── PATCH /api/posts/:id ──────────────────────────────────────────────────
router.patch("/:id",
  authenticate,
  [
    body("content").optional().isString().isLength({ max: 2000 }),
    body("visibility").optional().isIn(["public", "followers", "community", "private"]),
    body("tags").optional().isArray({ max: 10 }),
    body("aesthetics").optional().isArray({ max: 5 }),
    body("isNsfw").optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { content, visibility, tags, aesthetics, isNsfw } = req.body;

      // Check ownership
      const { rows: postRows } = await query(
        `SELECT user_id FROM posts WHERE id = $1`, [req.params.id]
      );
      if (!postRows.length) return res.status(404).json({ error: "Post not found" });
      if (postRows[0].user_id !== req.user.id && req.user.role === "user") {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Build dynamic update
      const updates = [];
      const values = [];
      let paramCount = 1;

      if (content !== undefined) {
        updates.push(`content = $${paramCount++}`);
        values.push(content);
      }
      if (visibility !== undefined) {
        updates.push(`visibility = $${paramCount++}`);
        values.push(visibility);
      }
      if (tags !== undefined) {
        updates.push(`tags = $${paramCount++}`);
        values.push(tags);
      }
      if (aesthetics !== undefined) {
        updates.push(`aesthetics = $${paramCount++}`);
        values.push(aesthetics);
      }
      if (isNsfw !== undefined) {
        updates.push(`is_nsfw = $${paramCount++}`);
        values.push(isNsfw);
      }

      if (!updates.length) {
        return res.status(400).json({ error: "No fields to update" });
      }

      updates.push(`updated_at = NOW()`);
      values.push(req.params.id);

      const { rows } = await query(
        `UPDATE posts SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
        values
      );

      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);
// ── POST /api/posts/:id/like ───────────────────────────────────────────────
router.post("/:id/like", authenticate, async (req, res, next) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const existing = await query(
      `SELECT 1 FROM likes WHERE user_id=$1 AND post_id=$2`, [userId, postId]
    );

    if (existing.rows.length) {
      // Unlike
      await transaction(async (client) => {
        await client.query(`DELETE FROM likes WHERE user_id=$1 AND post_id=$2`, [userId, postId]);
        await client.query(
          `UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1`, [postId]
        );
      });
      return res.json({ liked: false });
    }

    // Like
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, postId]
      );
      await client.query(
        `UPDATE posts SET like_count = like_count + 1 WHERE id = $1`, [postId]
      );
      // Notify post author
      const { rows: postRows } = await client.query(
        `SELECT user_id FROM posts WHERE id = $1`, [postId]
      );
      if (postRows.length && postRows[0].user_id !== userId) {
        await client.query(
          `INSERT INTO notifications (user_id, actor_id, type, post_id)
           VALUES ($1, $2, 'like', $3)`,
          [postRows[0].user_id, userId, postId]
        );
      }
    });

    // Boost aesthetic scores for liker
    const { rows: postAesthetics } = await query(
      `SELECT aesthetics FROM posts WHERE id = $1`, [postId]
    );
    if (postAesthetics.length) {
      updateUserAesthetics(userId, postAesthetics[0].aesthetics, 0.5).catch(() => {});
    }

    res.json({ liked: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/posts/:id/repost ─────────────────────────────────────────────
router.post("/:id/repost", authenticate, async (req, res, next) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const existing = await query(
      `SELECT 1 FROM reposts WHERE user_id=$1 AND post_id=$2`, [userId, postId]
    );

    if (existing.rows.length) {
      await transaction(async (client) => {
        await client.query(`DELETE FROM reposts WHERE user_id=$1 AND post_id=$2`, [userId, postId]);
        await client.query(
          `UPDATE posts SET repost_count = GREATEST(repost_count-1,0) WHERE id=$1`, [postId]
        );
      });
      return res.json({ reposted: false });
    }

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO reposts (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, postId]
      );
      await client.query(
        `UPDATE posts SET repost_count = repost_count + 1 WHERE id = $1`, [postId]
      );
      const { rows: postRows } = await client.query(
        `SELECT user_id FROM posts WHERE id = $1`, [postId]
      );
      if (postRows.length && postRows[0].user_id !== userId) {
        await client.query(
          `INSERT INTO notifications (user_id, actor_id, type, post_id)
           VALUES ($1, $2, 'repost', $3)`,
          [postRows[0].user_id, userId, postId]
        );
      }
    });

    res.json({ reposted: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/posts/:id/remix-chain ─────────────────────────────────────────
router.get("/:id/remix-chain", optionalAuth, async (req, res, next) => {
  try {
    // Walk the remix tree up to 10 levels deep using a recursive CTE
    const { rows } = await query(
      `WITH RECURSIVE chain AS (
         SELECT p.id, p.user_id, p.content, p.original_post_id,
                p.remix_depth, p.remix_note, p.created_at,
                u.handle, u.display_name, u.avatar_key
         FROM posts p JOIN users u ON u.id = p.user_id
         WHERE p.id = $1
       UNION ALL
         SELECT p.id, p.user_id, p.content, p.original_post_id,
                p.remix_depth, p.remix_note, p.created_at,
                u.handle, u.display_name, u.avatar_key
         FROM posts p JOIN users u ON u.id = p.user_id
         JOIN chain c ON c.original_post_id = p.id
         WHERE chain.remix_depth < 10
       )
       SELECT * FROM chain ORDER BY remix_depth`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/posts/:id/report ─────────────────────────────────────────────
router.post("/:id/report",
  authenticate,
  [
    body("reason").isIn(["spam", "harassment", "illegal_content", "nsfw_unmarked", "misinformation", "other"]),
    body("detail").optional().isString().isLength({ max: 500 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      await query(
        `INSERT INTO reports (reporter_id, post_id, reason, detail)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [req.user.id, req.params.id, req.body.reason, req.body.detail]
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── Helpers ────────────────────────────────────────────────────────────────
async function updateUserAesthetics(userId, aesthetics, weight) {
  if (!aesthetics?.length) return;
  for (const aesthetic of aesthetics) {
    await query(
      `INSERT INTO user_aesthetic_scores (user_id, aesthetic, score)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, aesthetic)
       DO UPDATE SET score = user_aesthetic_scores.score + $3, updated_at = NOW()`,
      [userId, aesthetic, weight]
    );
  }
}

module.exports = router;
