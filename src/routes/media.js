const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const { authenticate } = require("../middleware/authenticate");
const { uploadRateLimit } = require("../middleware/rateLimiter");
const { getS3, getPresignedUrl } = require("../services/storage");
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const router = express.Router();

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const ALLOWED_AUDIO_TYPES = ["audio/mpeg", "audio/ogg", "audio/wav", "audio/flac"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm"];
const MAX_SIZE_BYTES = parseInt(process.env.MAX_UPLOAD_SIZE_MB || "50") * 1024 * 1024;

// Store in memory for processing before R2 upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter(req, file, cb) {
    const allowed = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_AUDIO_TYPES, ...ALLOWED_VIDEO_TYPES];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// ── POST /api/media/upload ─────────────────────────────────────────────────
router.post("/upload",
  authenticate,
  uploadRateLimit,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file provided" });

      const { mimetype, buffer, originalname } = req.file;
      const ext = path.extname(originalname).toLowerCase() || mimeToExt(mimetype);
      const key = `${req.user.id}/${uuidv4()}${ext}`;
      const meta = {};

      let finalBuffer = buffer;

      // Process images: strip EXIF (privacy!), resize if huge, generate thumbnail
      if (ALLOWED_IMAGE_TYPES.includes(mimetype) && mimetype !== "image/gif") {
        const img = sharp(buffer).rotate(); // auto-rotate from EXIF, then strip it

        const imgMeta = await img.metadata();
        meta.width = imgMeta.width;
        meta.height = imgMeta.height;

        // Resize to max 2000px on longest side
        if (imgMeta.width > 2000 || imgMeta.height > 2000) {
          img.resize(2000, 2000, { fit: "inside", withoutEnlargement: true });
        }

        // Re-encode as WebP for storage efficiency (except GIFs)
        finalBuffer = await img
          .webp({ quality: 85 })
          .withMetadata(false)   // ← strips ALL metadata including GPS
          .toBuffer();

        // Upload thumbnail
        const thumbBuffer = await sharp(buffer)
          .rotate()
          .resize(400, 400, { fit: "cover" })
          .webp({ quality: 70 })
          .withMetadata(false)
          .toBuffer();

        const thumbKey = `${req.user.id}/thumb_${uuidv4()}.webp`;
        await uploadToR2(thumbKey, thumbBuffer, "image/webp");
        meta.thumbnailKey = thumbKey;
        meta.thumbnailUrl = `${process.env.R2_PUBLIC_URL}/${thumbKey}`;
      }

      // Upload main file
      await uploadToR2(key, finalBuffer, ALLOWED_IMAGE_TYPES.includes(mimetype) ? "image/webp" : mimetype);

      res.json({
        key,
        url: `${process.env.R2_PUBLIC_URL}/${key}`,
        meta,
        size: finalBuffer.length,
        mimeType: mimetype,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/media/presign — get a presigned URL for direct browser upload
// Useful for large video files that shouldn't proxy through the API server
router.post("/presign", authenticate, uploadRateLimit, async (req, res, next) => {
  try {
    const { filename, contentType } = req.body;
    const allowed = [...ALLOWED_AUDIO_TYPES, ...ALLOWED_VIDEO_TYPES];
    if (!allowed.includes(contentType)) {
      return res.status(400).json({ error: "Only audio/video can use presigned uploads" });
    }

    const ext = path.extname(filename).toLowerCase() || mimeToExt(contentType);
    const key = `${req.user.id}/${uuidv4()}${ext}`;
    const { url, fields } = await getPresignedUrl(key, contentType);

    res.json({ uploadUrl: url, fields, key, publicUrl: `${process.env.R2_PUBLIC_URL}/${key}` });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/media/:key ─────────────────────────────────────────────────
router.delete("/:key(*)", authenticate, async (req, res, next) => {
  try {
    const key = req.params.key;
    // Security: only allow deleting own files
    if (!key.startsWith(`${req.user.id}/`)) {
      return res.status(403).json({ error: "Cannot delete another user's media" });
    }
    const s3 = getS3();
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
async function uploadToR2(key, buffer, contentType) {
  const s3 = getS3();
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
  }));
}

function mimeToExt(mime) {
  const map = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
    "image/webp": ".webp", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
    "audio/wav": ".wav", "video/mp4": ".mp4", "video/webm": ".webm",
  };
  return map[mime] || "";
}

module.exports = router;
