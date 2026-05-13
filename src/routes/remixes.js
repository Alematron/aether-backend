const express = require("express");
const { body, validationResult } = require("express-validator");
const { query, transaction } = require("../db/pool");
const { authenticate, optionalAuth } = require("../middleware/authenticate");
const { scorePost } = require("../services/recommender");

const router = express.Router();

// ── POST /api/remixes ──────────────────────────────────────────────────────
// Create a remix of an existing post
router.post("/",
  authenticate,
  [
    body("originalPostId").isUUID(),
    body("content").optional().isString().isLength({ max: 2000 }),
    body("postType").isIn(["text", "image", "audio", "video", "collage"]),
    body("remixNote").optional().isString().isLength({ max: 300 }),
    body("mediaKeys").optional().isArray({ max: 10 }),
    body("tags").optional().isArray({ max: 10 }),
    body("aesthetics").optional().isArray({ max: 5 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { originalPostId, content, postType, remixNote, mediaKeys = [], tags = [], aesthetics = [] } = req.body;

      // Load original post
      const { rows: origRows } = await query(
        `SELECT id, user_id, remix_depth, aesthetics, tags, visibility
         FROM posts WHERE id = $1 AND is_hidden = false`,
        [originalPostId]
      );
      if (!origRows.length) return res.status(404).json({ error: "Original post not found" });

      const original = origRows[0];
      if (original.visibility === "private") {
        return res.status(403).json({ error: "Cannot remix a private post" });
      }

      const remixDepth = (original.remix_depth || 0) + 1;
      if (remixDepth > 10) {
        return res.status(400).json({ error: "Remix chain too deep (max 10)" });
      }

      // Merge aesthetics from original if remixer didn't specify
      const finalAesthetics = aesthetics.length ? aesthetics : original.aesthetics;
      const finalTags = [...new Set([...tags, ...(original.tags || [])])].slice(0, 10);

      const { rows } = await transaction(async (client) => {
        const post = await client.query(
          `INSERT INTO posts
             (user_id, content, post_type, original_post_id, remix_depth, remix_note,
              media_keys, tags, aesthetics, visibility)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'public')
           RETURNING *`,
          [req.user.id, content, postType, originalPostId, remixDepth, remixNote,
           mediaKeys, finalTags, finalAesthetics]
        );

        // Increment remix count on original
        await client.query(
          `UPDATE posts SET remix_count = remix_count + 1 WHERE id = $1`, [originalPostId]
        );
        await client.query(
          `UPDATE users SET post_count = post_count + 1 WHERE id = $1`, [req.user.id]
        );

        // Notify original author
        if (original.user_id !== req.user.id) {
          await client.query(
            `INSERT INTO notifications (user_id, actor_id, type, post_id, data)
             VALUES ($1, $2, 'remix', $3, $4)`,
            [original.user_id, req.user.id, post.rows[0].id,
             JSON.stringify({ remixedPostId: originalPostId })]
          );
        }

        return post.rows;
      });

      scorePost(rows[0]).catch(() => {});

      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/remixes/of/:postId ────────────────────────────────────────────
// Get all direct remixes of a post
router.get("/of/:postId", optionalAuth, async (req, res, next) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || "0"));
    const limit = Math.min(50, parseInt(req.query.limit || "20"));

    const { rows } = await query(
      `SELECT p.*, u.handle, u.display_name, u.avatar_key, u.badge
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.original_post_id = $1 AND p.is_hidden = false
       ORDER BY p.score DESC, p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.postId, limit, page * limit]
    );

    res.json({ remixes: rows, page, hasMore: rows.length === limit });
  } catch (err) { next(err); }
});

module.exports = router;
