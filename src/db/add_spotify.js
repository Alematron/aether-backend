require("dotenv").config();
const { pool } = require("../db/pool");

async function addSpotifyColumns() {
  console.log("Adding Spotify columns...");
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS spotify_access_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS spotify_refresh_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS spotify_token_expires TIMESTAMPTZ;
    `);
    console.log("Spotify columns added successfully!");
  } catch (err) {
    console.error("Failed:", err.message);
  } finally {
    await pool.end();
  }
}

addSpotifyColumns();