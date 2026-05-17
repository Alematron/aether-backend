require("dotenv").config();
const { pool } = require("./pool");
const logger = require("../utils/logger");

const SCHEMA = `
-- ──────────────────────────────────────────────
-- ÆTHER Database Schema
-- ──────────────────────────────────────────────

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- fuzzy search on tags/aesthetics

-- ── BEDROOM / PROFILE CUSTOMIZATION ──────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_theme VARCHAR(64) DEFAULT 'void';
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_wallpaper_key VARCHAR(512);
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_accent_color VARCHAR(16) DEFAULT '#c084fc';
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_mood VARCHAR(128);
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_mood_emoji VARCHAR(8) DEFAULT '🌙';
-- ──────────────────────────────────────────────
-- USERS
-- Pseudonymous-first: no real name required ever.
-- email is optional and stored hashed for login only.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  handle            VARCHAR(32) UNIQUE NOT NULL,       -- @voidpetal (public identity)
  display_name      VARCHAR(64),
  bio               TEXT,
  avatar_key        VARCHAR(512),                       -- R2 object key
  banner_key        VARCHAR(512),
  theme             VARCHAR(64) DEFAULT 'void_default',
  badge             VARCHAR(64),

  -- Auth (pseudonymous: email optional)
  email_hash        VARCHAR(128) UNIQUE,                -- bcrypt hash, never stored plain
  password_hash     VARCHAR(128) NOT NULL,
  is_email_verified BOOLEAN DEFAULT false,

  -- Privacy & Security
  is_pseudonymous   BOOLEAN DEFAULT true,
  hide_activity     BOOLEAN DEFAULT false,
  hide_location     BOOLEAN DEFAULT true,
  e2e_enabled       BOOLEAN DEFAULT true,
  data_minimize     BOOLEAN DEFAULT true,
  two_factor_secret VARCHAR(64),                        -- TOTP secret, null = disabled

  -- Status
  is_active         BOOLEAN DEFAULT true,
  is_banned         BOOLEAN DEFAULT false,
  ban_reason        TEXT,
  role              VARCHAR(16) DEFAULT 'user',         -- user | moderator | admin

  -- Stats (denormalized for feed performance)
  post_count        INTEGER DEFAULT 0,
  follower_count    INTEGER DEFAULT 0,
  following_count   INTEGER DEFAULT 0,

  -- Timestamps
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);

-- ──────────────────────────────────────────────
-- REFRESH TOKENS
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  device_hint VARCHAR(128),                             -- e.g. "Berlin, DE · Chrome"
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ──────────────────────────────────────────────
-- FOLLOWS
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

-- ──────────────────────────────────────────────
-- POSTS
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT,
  post_type       VARCHAR(16) NOT NULL DEFAULT 'text',  -- text|image|audio|video|collage
  visibility      VARCHAR(16) DEFAULT 'public',         -- public|followers|community|private

  -- Media
  media_keys      TEXT[],                               -- R2 object keys
  media_meta      JSONB DEFAULT '{}',                   -- dimensions, duration, thumbnails

  -- Remix lineage
  original_post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  remix_depth      INTEGER DEFAULT 0,                   -- 0 = original, 1 = direct remix, etc.
  remix_note       TEXT,                                -- creator's remix commentary

  -- Aesthetic tagging (drives recommendations)
  tags            TEXT[] DEFAULT '{}',
  aesthetics      TEXT[] DEFAULT '{}',                  -- shrinecore, glitchpunk, etc.
  community_id    UUID,                                 -- set after communities table

  -- Stats (denormalized)
  like_count      INTEGER DEFAULT 0,
  repost_count    INTEGER DEFAULT 0,
  remix_count     INTEGER DEFAULT 0,
  view_count      INTEGER DEFAULT 0,
  score           FLOAT DEFAULT 0,                      -- feed ranking score (updated by worker)

  -- Safety
  is_nsfw         BOOLEAN DEFAULT false,
  is_hidden       BOOLEAN DEFAULT false,
  hide_reason     VARCHAR(64),
  content_hash    VARCHAR(128),                         -- for duplicate/spam detection

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_user       ON posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts(created_at DESC) WHERE is_hidden = false;
CREATE INDEX IF NOT EXISTS idx_posts_score      ON posts(score DESC) WHERE is_hidden = false;
CREATE INDEX IF NOT EXISTS idx_posts_original   ON posts(original_post_id);
CREATE INDEX IF NOT EXISTS idx_posts_tags       ON posts USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_posts_aesthetics ON posts USING GIN(aesthetics);
CREATE INDEX IF NOT EXISTS idx_posts_community  ON posts(community_id, created_at DESC);

-- ──────────────────────────────────────────────
-- LIKES / REPOSTS
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS likes (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS reposts (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

-- ──────────────────────────────────────────────
-- COMMUNITIES (Worlds)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS communities (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug         VARCHAR(64) UNIQUE NOT NULL,             -- shrine.world
  name         VARCHAR(128) NOT NULL,
  description  TEXT,
  icon         VARCHAR(8),                              -- emoji
  banner_key   VARCHAR(512),
  owner_id     UUID NOT NULL REFERENCES users(id),
  visibility   VARCHAR(16) DEFAULT 'public',            -- public|private|invite
  theme        VARCHAR(64) DEFAULT 'void_default',
  aesthetics   TEXT[] DEFAULT '{}',
  rules        TEXT,

  member_count INTEGER DEFAULT 0,
  post_count   INTEGER DEFAULT 0,

  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_communities_slug      ON communities(slug);
CREATE INDEX IF NOT EXISTS idx_communities_aesthetics ON communities USING GIN(aesthetics);

-- Add FK now that communities exists
ALTER TABLE posts ADD CONSTRAINT fk_posts_community
  FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL
  NOT VALID;  -- NOT VALID = skip validating existing rows, fast migration

CREATE TABLE IF NOT EXISTS community_members (
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         VARCHAR(16) DEFAULT 'member',            -- member|mod|admin
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (community_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_community_members_user ON community_members(user_id);

-- ──────────────────────────────────────────────
-- NOTIFICATIONS
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  type        VARCHAR(32) NOT NULL,   -- like|repost|remix|follow|mention|security|system
  post_id     UUID REFERENCES posts(id) ON DELETE CASCADE,
  data        JSONB DEFAULT '{}',
  is_read     BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC) WHERE is_read = false;

-- ──────────────────────────────────────────────
-- USER AESTHETIC PROFILE (feeds the recommender)
-- Tracks which aesthetics a user engages with.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_aesthetic_scores (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aesthetic VARCHAR(64) NOT NULL,
  score     FLOAT DEFAULT 0,          -- weighted engagement score
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, aesthetic)
);

CREATE INDEX IF NOT EXISTS idx_aesthetic_scores_user ON user_aesthetic_scores(user_id, score DESC);

-- ──────────────────────────────────────────────
-- REPORTS (Trust & Safety)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     UUID REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,  -- reported user
  reason      VARCHAR(64) NOT NULL,
  detail      TEXT,
  status      VARCHAR(16) DEFAULT 'pending',  -- pending|reviewed|actioned|dismissed
  reviewed_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

-- ──────────────────────────────────────────────
-- BLOCKS
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- ──────────────────────────────────────────────
-- FEED CACHE (materialized per-user feed rows)
-- Populated asynchronously by the recommendation worker.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_items (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  feed_type  VARCHAR(16) DEFAULT 'foryou',   -- foryou|following|trending|remixes
  score      FLOAT DEFAULT 0,
  reason     VARCHAR(32),                    -- why this was recommended
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, post_id, feed_type)
);

CREATE INDEX IF NOT EXISTS idx_feed_items_user ON feed_items(user_id, feed_type, score DESC);

-- ──────────────────────────────────────────────
-- TRIGGER: auto-update updated_at
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER posts_updated_at BEFORE UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

async function migrate() {
  console.log("Running ÆTHER migrations...");
  try {
    await pool.query(SCHEMA);
    console.log("✓ Schema applied successfully");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
