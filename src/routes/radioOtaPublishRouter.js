import express from 'express';
import crypto from 'crypto';
import { getAllRadios } from '../db/index.js';
import { sendDataToRadioToken } from '../services/fcmService.js';
import { createOtaRelease, assignReleaseToRadios } from '../services/radioOtaService.js';

const router = express.Router();
const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';
const MAX_APK_BYTES = 120 * 1024 * 1024;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function requirePublisherToken(req, res, next) {
  const configured = process.env.OTA_PUBLISH_TOKEN;
  if (!configured) return res.status(503).json({ error: 'OTA_PUBLISH_TOKEN is not configured' });
  if (!safeEqual(req.headers['x-ota-publish-token'], configured)) {
    return res.status(401).json({ error: 'Invalid OTA publish token' });
  }
  next();
}

// CI one-shot endpoint: store the newly built T320 APK, queue it for every
// registered radio, then send FCM wakeups. Radios without FCM pick it up from
// their 60-second OTA poll loop.
router.post(
  '/publish-and-push',
  requirePublisherToken,
  express.raw({ type: APK_CONTENT_TYPE, limit: MAX_APK_BYTES }),
  async (req, res) => {
    const versionCode = Number(req.query.versionCode);
    const versionName = String(req.query.versionName || '').trim();
    const notes = String(req.query.notes || '').trim() || null;
    if (!Number.isInteger(versionCode) || versionCode <= 0 || !versionName) {
      return res.status(400).json({ error: 'Valid versionCode and versionName are required' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 1024) {
      return res.status(400).json({ error: 'APK body is required' });
    }

    try {
      const release = await createOtaRelease({
        versionCode,
        versionName,
        notes,
        apkBytes: req.body,
        createdBy: null,
      });
      const radios = await getAllRadios();
      await assignReleaseToRadios(release.id, radios.map(r => r.radio_id));

      let fcmDelivered = 0;
      let fcmFailed = 0;
      let noFcm = 0;
      await Promise.all(radios.map(async (radio) => {
        if (!radio.fcm_token) {
          noFcm += 1;
          return;
        }
        try {
          const result = await sendDataToRadioToken(radio.fcm_token, {
            type: 'ota_update',
            releaseId: String(release.id),
            versionCode: String(release.version_code),
            versionName: release.version_name,
            sha256: release.sha256,
          });
          if (result?.success) fcmDelivered += 1;
          else fcmFailed += 1;
        } catch {
          fcmFailed += 1;
        }
      }));

      return res.status(201).json({
        ok: true,
        release,
        queued: radios.length,
        delivery: { fcmDelivered, fcmFailed, noFcm },
      });
    } catch (err) {
      console.error('[OTA-CI] publish failed:', err);
      return res.status(500).json({ error: err.message || 'OTA publish failed' });
    }
  }
);

export default router;
