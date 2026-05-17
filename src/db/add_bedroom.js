require("dotenv").config();
const { pool } = require("./pool");

async function addBedroomColumns() {
  console.log("Adding bedroom columns...");
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS room_theme VARCHAR(64) DEFAULT 'void';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS room_wallpaper_key VARCHAR(512);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS room_accent_color VARCHAR(16) DEFAULT '#c084fc';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS room_mood VARCHAR(128);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS room_mood_emoji VARCHAR(8) DEFAULT '🌙';
    `);
    console.log("Bedroom columns added successfully!");
  } catch (err) {
    console.error("Failed:", err.message);
  } finally {
    await pool.end();
  }
}

addBedroomColumns();