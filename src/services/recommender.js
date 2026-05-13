/**
 * ÆTHER Recommendation Engine
 *
 * Architecture:
 *  1. scorePost()     — compute a ranking score for a post when it's created/updated
 *  2. buildFeed()     — build a personalized "For You" feed for a user
 *  3. fanoutToFollowers() — push a new post into followers' feed caches
 *  4. refreshTrending()  — recompute trending feed (runs on a cron)
 *
 * Scoring formula (Wilson-score-style with aesthetic affinity boost):
 *   base_score   = log(1 + likes) * 1.0
 *               + log(1 + reposts) * 1.8
 *               + log(1 + remixes) * 3.0
 *               + log(1 + views)   * 0.1
 *   decay        = exp(-hours_since_post / 18)   <- half-life ~18 hours
 *   affinity     = dot(user_aesthetic_vector, post_aesthetic_vector)  [0..1]
 *   final_score  = base_score * decay * (1 + 0.5 * affinity)
 */

const { query, transaction } = require("../db/pool");
const { getRedis } = require("./redis");
const logger = require("../utils/logger");

const FEED_TTL_SECONDS = 60 * 60 * 6;  // Feed cache valid for 6 hours
const FEED_MAX_SIZE = 200;              // Max posts kept per user feed

// ── Score a single post (called on create + on background refresh) ─────────
async function scorePost(post) {
  const ageHours = (Date.now() - new Date(post.created_at).getTime()) / 3600000;

  const baseScore =
    Math.log1p(post.like_count)   * 1.0 +
    Math.log1p(post.repost_count) * 1.8 +
    Math.log1p(post.remix_count)  * 3.0 +
    Math.log1p(post.view_count)   * 0.1;

  const decay = Math.exp(-ageHours / 18);
  const score = baseScore * decay;

  await query(`UPDATE posts SET score = $1 WHERE id = $2`, [score, post.id]);

  // Fan out to followers' feeds
  await fanoutToFollowers(post, score);

  return score;
}

// ── Fan-out: insert post into each follower's feed cache ───────────────────
async function fanoutToFollowers(post, score) {
  if (post.visibility !== "public" && post.visibility !== "followers") return;

  // Get followers (cap at 5000 for large accounts — use pull model beyond that)
  const { rows: followers } = await query(
    `SELECT follower_id FROM follows WHERE followee_id = $1 LIMIT 5000`,
    [post.user_id]
  );

  if (!followers.length) return;

  // Batch upsert into feed_items
  const values = followers
    .map((f, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`)
    .join(",");

  const params = followers.flatMap(f => [
    f.follower_id, post.id, "following", score, "follow"
  ]);

  await query(
    `INSERT INTO feed_items (user_id, post_id, feed_type, score, reason)
     VALUES ${values}
     ON CONFLICT (user_id, post_id, feed_type) DO UPDATE SET score = EXCLUDED.score`,
    params
  );
}

// ── Build personalized "For You" feed ─────────────────────────────────────
async function buildFeed(userId, feedType = "foryou", page = 0, limit = 20) {
  const offset = page * limit;

  if (feedType === "following") {
    return buildFollowingFeed(userId, offset, limit);
  }
  if (feedType === "trending") {
    return buildTrendingFeed(offset, limit);
  }
  if (feedType === "remixes") {
    return buildRemixFeed(userId, offset, limit);
  }

  // "For You" — personalized by aesthetic affinity
  return buildForYouFeed(userId, offset, limit);
}

async function buildForYouFeed(userId, offset, limit) {
  // Step 1: get user's top aesthetics
  const { rows: aestheticRows } = await query(
    `SELECT aesthetic, score FROM user_aesthetic_scores
     WHERE user_id = $1 ORDER BY score DESC LIMIT 10`,
    [userId]
  );

  // Step 2: get blocked users so we exclude them
  const { rows: blocked } = await query(
    `SELECT blocked_id FROM blocks WHERE blocker_id = $1
     UNION SELECT blocker_id FROM blocks WHERE blocked_id = $1`,
    [userId]
  );
  const blockedIds = blocked.map(b => b.blocked_id || b.blocker_id);

  if (!aestheticRows.length) {
    // New user — serve chronological public posts
    return buildTrendingFeed(offset, limit, blockedIds);
  }

  const aesthetics = aestheticRows.map(r => r.aesthetic);
  const maxScore = aestheticRows[0].score || 1;

  // Step 3: weighted query
  // Posts matching user aesthetics get affinity boost in ORDER BY
  const { rows } = await query(
    `SELECT p.*,
            u.handle, u.display_name, u.avatar_key, u.badge,
            (
              p.score * (
                1 + 0.5 * (
                  SELECT COALESCE(SUM(uas.score / $4), 0)
                  FROM unnest(p.aesthetics) pa
                  JOIN user_aesthetic_scores uas
                    ON uas.user_id = $1 AND uas.aesthetic = pa
                )
              )
            ) AS personalized_score
     FROM posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.is_hidden = false
       AND p.visibility = 'public'
       AND p.user_id != $1
       AND ($5::uuid[] IS NULL OR p.user_id != ALL($5))
       AND p.created_at > NOW() - INTERVAL '7 days'
     ORDER BY personalized_score DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset, maxScore, blockedIds.length ? blockedIds : null]
  );

  return rows;
}

async function buildFollowingFeed(userId, offset, limit) {
  const { rows } = await query(
    `SELECT p.*, u.handle, u.display_name, u.avatar_key, u.badge
     FROM posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.user_id IN (
       SELECT followee_id FROM follows WHERE follower_id = $1
     )
     AND p.is_hidden = false
     AND p.visibility IN ('public', 'followers')
     ORDER BY p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

async function buildTrendingFeed(offset, limit, excludeUserIds = []) {
  const { rows } = await query(
    `SELECT p.*, u.handle, u.display_name, u.avatar_key, u.badge
     FROM posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.is_hidden = false
       AND p.visibility = 'public'
       AND p.created_at > NOW() - INTERVAL '48 hours'
       AND ($3::uuid[] IS NULL OR p.user_id != ALL($3))
     ORDER BY p.score DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset, excludeUserIds.length ? excludeUserIds : null]
  );
  return rows;
}

async function buildRemixFeed(userId, offset, limit) {
  const { rows } = await query(
    `SELECT p.*, u.handle, u.display_name, u.avatar_key, u.badge,
            op.content AS original_content, ou.handle AS original_handle
     FROM posts p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN posts op ON op.id = p.original_post_id
     LEFT JOIN users ou ON ou.id = op.user_id
     WHERE p.original_post_id IS NOT NULL
       AND p.is_hidden = false
       AND (
         p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
         OR p.score > 5
       )
     ORDER BY p.score DESC, p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

// ── Discover: find aesthetically similar users ────────────────────────────
async function findSimilarUsers(userId, limit = 10) {
  // Cosine-similarity approximation via shared aesthetic scores
  const { rows } = await query(
    `WITH my_scores AS (
       SELECT aesthetic, score FROM user_aesthetic_scores WHERE user_id = $1
     ),
     other_scores AS (
       SELECT uas.user_id,
              SUM(uas.score * ms.score) AS dot_product,
              SQRT(SUM(uas.score^2)) AS other_norm,
              SQRT(SUM(ms.score^2)) AS my_norm
       FROM user_aesthetic_scores uas
       JOIN my_scores ms ON ms.aesthetic = uas.aesthetic
       WHERE uas.user_id != $1
       GROUP BY uas.user_id
       HAVING COUNT(*) >= 2
     )
     SELECT u.id, u.handle, u.display_name, u.avatar_key, u.badge,
            u.follower_count, u.bio,
            (os.dot_product / NULLIF(os.other_norm * os.my_norm, 0)) AS similarity
     FROM other_scores os
     JOIN users u ON u.id = os.user_id
     WHERE u.is_active = true AND u.is_banned = false
       AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = $1)
       AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1)
     ORDER BY similarity DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// ── Background: refresh scores for active posts ───────────────────────────
async function refreshActivePosts() {
  const { rows } = await query(
    `SELECT id, like_count, repost_count, remix_count, view_count, created_at
     FROM posts
     WHERE is_hidden = false
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY score DESC
     LIMIT 1000`
  );

  for (const post of rows) {
    const ageHours = (Date.now() - new Date(post.created_at).getTime()) / 3600000;
    const baseScore =
      Math.log1p(post.like_count)   * 1.0 +
      Math.log1p(post.repost_count) * 1.8 +
      Math.log1p(post.remix_count)  * 3.0 +
      Math.log1p(post.view_count)   * 0.1;
    const score = baseScore * Math.exp(-ageHours / 18);
    await query(`UPDATE posts SET score = $1 WHERE id = $2`, [score, post.id]);
  }

  logger.info(`Refreshed scores for ${rows.length} active posts`);
}

module.exports = {
  scorePost,
  buildFeed,
  fanoutToFollowers,
  findSimilarUsers,
  refreshActivePosts,
};
