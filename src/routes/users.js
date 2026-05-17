const express = require("express");
const { body, validationResult } = require("express-validator");
const { query, transaction } = require("../db/pool");
const { authenticate, optionalAuth } = require("../middleware/authenticate");
const { findSimilarUsers } = require("../services/recommender");

const router = express.Router();

router.get("/me/notifications", authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT n.*, u.handle AS actor_handle, u.avatar_key AS actor_avatar
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    query(`UPDATE notifications SET is_read=true WHERE user_id=$1 AND is_read=false`, [req.user.id]).catch(() => {});
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/me/similar", authenticate, async (req, res, next) => {
  try {
    const users = await findSimilarUsers(req.user.id);
    res.json(users);
  } catch (err) { next(err); }
});

router.patch("/me",
  authenticate,
  [
    body("displayName").optional().isString().isLength({ max: 64 }),
    body("bio").optional().isString().isLength({ max: 300 }),
    body("theme").optional().isString().isLength({ max: 64 }),
    body("avatarKey").optional().isString(),
    body("bannerKey").optional().isString(),
    body("isPseudonymous").optional().isBoolean(),
    body("hideActivity").optional().isBoolean(),
    body("hideLocation").optional().isBoolean(),
    body("e2eEnabled").optional().isBoolean(),
    body("dataMinimize").optional().isBoolean(),
    body("roomTheme").optional().isString().isLength({ max: 64 }),
    body("roomWallpaperKey").optional().isString(),
    body("roomAccentColor").optional().isString().isLength({ max: 16 }),
    body("roomMood").optional().isString().isLength({ max: 128 }),
    body("roomMoodEmoji").optional().isString().isLength({ max: 8 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const fields = {
        display_name:       req.body.displayName,
        bio:                req.body.bio,
        theme:              req.body.theme,
        avatar_key:         req.body.avatarKey,
        banner_key:         req.body.bannerKey,
        is_pseudonymous:    req.body.isPseudonymous,
        hide_activity:      req.body.hideActivity,
        hide_location:      req.body.hideLocation,
        e2e_enabled:        req.body.e2eEnabled,
        data_minimize:      req.body.dataMinimize,
        room_theme:         req.body.roomTheme,
        room_wallpaper_key: req.body.roomWallpaperKey,
        room_accent_color:  req.body.roomAccentColor,
        room_mood:          req.body.roomMood,
        room_mood_emoji:    req.body.roomMoodEmoji,
      };

      const updates = Object.entries(fields)
        .filter(function(entry) { return entry[1] !== undefined; })
        .map(function(entry, i) { return entry[0] + ' = $' + (i + 2); });

      if (!updates.length) return res.status(400).json({ error: "No fields to update" });

      const values = Object.values(fields).filter(function(v) { return v !== undefined; });

      const { rows } = await query(
        'UPDATE users SET ' + updates.join(', ') + ' WHERE id = $1 ' +
        'RETURNING id, handle, display_name, bio, theme, avatar_key, banner_key, ' +
        'is_pseudonymous, hide_activity, hide_location, e2e_enabled, data_minimize, ' +
        'room_theme, room_wallpaper_key, room_accent_color, room_mood, room_mood_emoji',
        [req.user.id, ...values]
      );

      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.get("/:handle", optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, handle, display_name, bio, avatar_key, banner_key,
              theme, badge, follower_count, following_count, post_count,
              created_at, is_pseudonymous,
              room_theme, room_wallpaper_key, room_accent_color, room_mood, room_mood_emoji,
              CASE WHEN hide_activity THEN NULL ELSE last_seen_at END AS last_seen_at
       FROM users
       WHERE handle = $1 AND is_active = true AND is_banned = false`,
      [req.params.handle]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });

    const user = rows[0];

    if (req.user && req.user.id !== user.id) {
      const [followRow, blockRow] = await Promise.all([
        query(`SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2`, [req.user.id, user.id]),
        query(`SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2`, [req.user.id, user.id]),
      ]);
      user.viewerFollows = !!followRow.rows.length;
      user.viewerBlocked = !!blockRow.rows.length;
    }

    res.json(user);
  } catch (err) { next(err); }
});

router.get("/:handle/posts", optionalAuth, async (req, res, next) => {
  try {
    const { rows: userRows } = await query(
      `SELECT id FROM users WHERE handle = $1`, [req.params.handle]
    );
    if (!userRows.length) return res.status(404).json({ error: "User not found" });

    const userId = userRows[0].id;
    const page = Math.max(0, parseInt(req.query.page || "0"));
    const limit = Math.min(50, parseInt(req.query.limit || "20"));
    const isOwn = req.user?.id === userId;

    const { rows } = await query(
      `SELECT p.*, u.handle, u.display_name, u.avatar_key
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1
         AND p.is_hidden = false
         AND ($4 OR p.visibility = 'public')
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, page * limit, isOwn]
    );

    res.json({ posts: rows, page, hasMore: rows.length === limit });
  } catch (err) { next(err); }
});

router.post("/:handle/follow", authenticate, async (req, res, next) => {
  try {
    const { rows: targetRows } = await query(
      `SELECT id FROM users WHERE handle = $1 AND is_active = true`, [req.params.handle]
    );
    if (!targetRows.length) return res.status(404).json({ error: "User not found" });

    const targetId = targetRows[0].id;
    if (targetId === req.user.id) return res.status(400).json({ error: "Cannot follow yourself" });

    const existing = await query(
      `SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2`, [req.user.id, targetId]
    );

    if (existing.rows.length) {
      await transaction(async (client) => {
        await client.query(`DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2`, [req.user.id, targetId]);
        await client.query(`UPDATE users SET follower_count = GREATEST(follower_count-1,0) WHERE id=$1`, [targetId]);
        await client.query(`UPDATE users SET following_count = GREATEST(following_count-1,0) WHERE id=$1`, [req.user.id]);
      });
      return res.json({ following: false });
    }

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.user.id, targetId]
      );
      await client.query(`UPDATE users SET follower_count = follower_count+1 WHERE id=$1`, [targetId]);
      await client.query(`UPDATE users SET following_count = following_count+1 WHERE id=$1`, [req.user.id]);
      await client.query(
        `INSERT INTO notifications (user_id, actor_id, type) VALUES ($1,$2,'follow')`,
        [targetId, req.user.id]
      );
    });

    res.json({ following: true });
  } catch (err) { next(err); }
});

router.post("/:handle/block", authenticate, async (req, res, next) => {
  try {
    const { rows: targetRows } = await query(
      `SELECT id FROM users WHERE handle = $1`, [req.params.handle]
    );
    if (!targetRows.length) return res.status(404).json({ error: "User not found" });

    const targetId = targetRows[0].id;
    const existing = await query(
      `SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2`, [req.user.id, targetId]
    );

    if (existing.rows.length) {
      await query(`DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2`, [req.user.id, targetId]);
      return res.json({ blocked: false });
    }

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.user.id, targetId]
      );
      await client.query(`DELETE FROM follows WHERE (follower_id=$1 AND followee_id=$2) OR (follower_id=$2 AND followee_id=$1)`, [req.user.id, targetId]);
    });

    res.json({ blocked: true });
  } catch (err) { next(err); }
});

module.exports = router;