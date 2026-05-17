require("dotenv").config();
const { pool } = require("../db/pool");

async function addAutoplay() {
  console.log("Adding autoplay column...");
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS room_autoplay VARCHAR(16) DEFAULT 'none';
    `);
    console.log("Done!");
  } catch (err) {
    console.error("Failed:", err.message);
  } finally {
    await pool.end();
  }
}

addAutoplay();