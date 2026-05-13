const express = require("express");
const { body, validationResult } = require("express-validator");
const { query, transaction } = require("../db/pool");
const { authenticate, optionalAuth } = require("../middleware/authenticate");

const router = express.Router();

// ── GET /api/communities ───────────────────────────────────────────────────
router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const search = req.query.search || "";
    const { rows } = await query(
      `SELECT c.*, u.handle AS owner_handle
       FROM communities c
       JOIN users u ON u.id = c.owner_id
       WHERE c.visibility = 'public'
         AND ($1 = '' OR c.name ILIKE $2 OR c.slug ILIKE $2 OR $1 = ANY(c.aesthetics))
       ORDER BY c.member_count DESC
       LIMIT 50`,
      [search, `%${search}%`]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/communities ──────────────────────────────────────────────────
router.post("/",
  authenticate,
  [
    body("slug").matches(/^[a-z0-9._-]{3,64}$/).withMessage("Slug must be 3–64 lowercase chars, dots, dashes, underscores"),
    body("name").isString().isLength({ min: 2, max: 128 }),
    body("description").optional().isString().isLength({ max: 500 }),
    body("icon").optional().isString().isLength({ max: 8 }),
    body("visibility").optional().isIn(["public", "private", "invite"]),
    body("aesthetics").optional().isArray({ max: 5 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { slug, name, description, icon, visibility = "public", aesthetics = [] } = req.body;

      const existing = await query(`SELECT id FROM communities WHERE slug=$1`, [slug]);
      if (existing.rows.length) return res.status(409).json({ error: "That slug is taken" });

      const { rows } = await transaction(async (client) => {
        const comm = await client.query(
          `INSERT INTO communities (slug, name, description, icon, owner_id, visibility, aesthetics, member_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1)
           RETURNING *`,
          [slug, name, description, icon, req.user.id, visibility, aesthetics]
        );
        await client.query(
          `INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,'admin')`,
          [comm.rows[0].id, req.user.id]
        );
        return comm.rows;
      });

      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/communities/:slug ─────────────────────────────────────────────
router.get("/:slug", optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, u.handle AS owner_handle, u.avatar_key AS owner_avatar
       FROM communities c JOIN users u ON u.id = c.owner_id
       WHERE c.slug = $1`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Community not found" });

    const community = rows[0];
    if (req.user) {
      const memberRow = await query(
        `SELECT role FROM community_members WHERE community_id=$1 AND user_id=$2`,
        [community.id, req.user.id]
      );
      community.viewerRole = memberRow.rows[0]?.role || null;
    }

    res.json(community);
  } catch (err) { next(err); }
});

// ── POST /api/communities/:slug/join ──────────────────────────────────────
router.post("/:slug/join", authenticate, async (req, res, next) => {
  try {
    const { rows: commRows } = await query(
      `SELECT id, visibility FROM communities WHERE slug=$1`, [req.params.slug]
    );
    if (!commRows.length) return res.status(404).json({ error: "Not found" });

    const { id: commId, visibility } = commRows[0];
    if (visibility === "invite") return res.status(403).json({ error: "This community is invite-only" });

    const existing = await query(
      `SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2`, [commId, req.user.id]
    );
    if (existing.rows.length) {
      // Leave
      await transaction(async (client) => {
        await client.query(`DELETE FROM community_members WHERE community_id=$1 AND user_id=$2`, [commId, req.user.id]);
        await client.query(`UPDATE communities SET member_count=GREATEST(member_count-1,0) WHERE id=$1`, [commId]);
      });
      return res.json({ joined: false });
    }

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO community_members (community_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [commId, req.user.id]
      );
      await client.query(`UPDATE communities SET member_count=member_count+1 WHERE id=$1`, [commId]);
    });

    res.json({ joined: true });
  } catch (err) { next(err); }
});

// ── GET /api/communities/:slug/posts ──────────────────────────────────────
router.get("/:slug/posts", optionalAuth, async (req, res, next) => {
  try {
    const { rows: commRows } = await query(
      `SELECT id, visibility FROM communities WHERE slug=$1`, [req.params.slug]
    );
    if (!commRows.length) return res.status(404).json({ error: "Not found" });

    const { id: commId, visibility } = commRows[0];

    if (visibility !== "public") {
      if (!req.user) return res.status(401).json({ error: "Login required" });
      const memberRow = await query(
        `SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2`, [commId, req.user.id]
      );
      if (!memberRow.rows.length) return res.status(403).json({ error: "Members only" });
    }

    const page = Math.max(0, parseInt(req.query.page || "0"));
    const limit = Math.min(50, parseInt(req.query.limit || "20"));

    const { rows } = await query(
      `SELECT p.*, u.handle, u.display_name, u.avatar_key
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.community_id = $1 AND p.is_hidden = false
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [commId, limit, page * limit]
    );

    res.json({ posts: rows, page, hasMore: rows.length === limit });
  } catch (err) { next(err); }
});

module.exports = router;
