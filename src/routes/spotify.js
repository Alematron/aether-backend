const express = require("express");
const { authenticate } = require("../middleware/authenticate");
const { query } = require("../db/pool");

const router = express.Router();

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SCOPES = "user-read-currently-playing user-read-recently-played user-read-playback-state streaming user-read-email user-read-private playlist-read-private playlist-read-collaborative";

router.get("/login", authenticate, (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
    state: req.user.id,
  });
  res.json({ url: SPOTIFY_AUTH_URL + "?" + params.toString() });
});

router.get("/callback", async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code) return res.redirect(process.env.FRONTEND_URL + "/profile?spotify=error");
  try {
    const creds = Buffer.from(
      process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
    ).toString("base64");
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + creds,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      }),
    });
    const tokens = await response.json();
    if (!tokens.access_token) throw new Error("No access token");
    await query(
      "UPDATE users SET spotify_access_token = $1, spotify_refresh_token = $2, spotify_token_expires = NOW() + INTERVAL '1 hour' WHERE id = $3",
      [tokens.access_token, tokens.refresh_token, userId]
    );
    res.redirect(process.env.FRONTEND_URL + "/profile?spotify=connected");
  } catch (err) {
    res.redirect(process.env.FRONTEND_URL + "/profile?spotify=error");
  }
});

router.get("/now-playing/:handle", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT spotify_access_token, spotify_refresh_token, spotify_token_expires FROM users WHERE handle = $1",
      [req.params.handle]
    );
    if (!rows.length || !rows[0].spotify_access_token) {
      return res.json({ connected: false });
    }
    let token = rows[0].spotify_access_token;
    if (new Date() > new Date(rows[0].spotify_token_expires)) {
      token = await refreshSpotifyToken(rows[0].spotify_refresh_token, req.params.handle);
      if (!token) return res.json({ connected: false });
    }
    const response = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: "Bearer " + token },
    });
    if (response.status === 204 || response.status === 404) {
      return res.json({ connected: true, playing: false });
    }
    const data = await response.json();
    if (!data || !data.item) return res.json({ connected: true, playing: false });
    res.json({
      connected: true,
      playing: true,
      track: {
        name: data.item.name,
        artist: data.item.artists.map(function(a) { return a.name }).join(", "),
        album: data.item.album.name,
        albumArt: data.item.album.images[0] ? data.item.album.images[0].url : null,
        url: data.item.external_urls.spotify,
        progress: data.progress_ms,
        duration: data.item.duration_ms,
      }
    });
  } catch (err) {
    res.json({ connected: false });
  }
});

router.get("/token", authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT spotify_access_token, spotify_refresh_token, spotify_token_expires FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!rows.length || !rows[0].spotify_access_token) {
      return res.status(401).json({ error: "Not connected to Spotify" });
    }
    let token = rows[0].spotify_access_token;
    if (new Date() > new Date(rows[0].spotify_token_expires)) {
      token = await refreshSpotifyToken(rows[0].spotify_refresh_token, req.user.id);
      if (!token) return res.status(401).json({ error: "Token refresh failed" });
    }
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

router.get("/playlists", authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT spotify_access_token, spotify_token_expires, spotify_refresh_token FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!rows.length || !rows[0].spotify_access_token) {
      return res.status(401).json({ error: "Not connected" });
    }
    let token = rows[0].spotify_access_token;
    if (new Date() > new Date(rows[0].spotify_token_expires)) {
      token = await refreshSpotifyToken(rows[0].spotify_refresh_token, req.user.id);
    }
    const response = await fetch("https://api.spotify.com/v1/me/playlists?limit=20", {
      headers: {
        Authorization: "Bearer " + token,
        'Cache-Control': 'no-cache',
      },
    });
    const data = await response.json();
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch playlists" });
  }
});

router.put("/play", authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT spotify_access_token, spotify_token_expires, spotify_refresh_token FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!rows.length || !rows[0].spotify_access_token) {
      return res.status(401).json({ error: "Not connected" });
    }
    let token = rows[0].spotify_access_token;
    if (new Date() > new Date(rows[0].spotify_token_expires)) {
      token = await refreshSpotifyToken(rows[0].spotify_refresh_token, req.user.id);
    }
    const { deviceId, contextUri, trackUri } = req.body;
    const body = contextUri ? { context_uri: contextUri } : { uris: [trackUri] };
    await fetch("https://api.spotify.com/v1/me/player/play?device_id=" + deviceId, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to play" });
  }
});

router.delete("/disconnect", authenticate, async (req, res) => {
  await query(
    "UPDATE users SET spotify_access_token = NULL, spotify_refresh_token = NULL WHERE id = $1",
    [req.user.id]
  );
  res.json({ ok: true });
});

async function refreshSpotifyToken(refreshToken, userId) {
  try {
    const creds = Buffer.from(
      process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
    ).toString("base64");
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + creds,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const tokens = await response.json();
    if (!tokens.access_token) return null;
    await query(
      "UPDATE users SET spotify_access_token = $1, spotify_token_expires = NOW() + INTERVAL '1 hour' WHERE id = $2",
      [tokens.access_token, userId]
    );
    return tokens.access_token;
  } catch { return null; }
}

module.exports = router;