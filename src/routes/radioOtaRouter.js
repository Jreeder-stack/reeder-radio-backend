import express from 'express';
import { radioAuth } from '../middleware/radioAuth.js';
import { requireAdmin } from '../middleware/auth.js';
import { getAllRadios, logActivity } from '../db/index.js';
import { sendDataToRadioToken } from '../services/fcmService.js';
import {
  createOtaRelease,
  listOtaReleases,
  getOtaRelease,
  assignReleaseToRadios,
  getPendingOtaForRadio,
  updateOtaStatus,
  getOtaAssignmentSummary,
} from '../services/radioOtaService.js';

const router = express.Router();
const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';
const MAX_APK_BYTES = 120 * 1024 * 1024;

function intParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Admin uploads one signed T320 APK directly into persistent Postgres storage.
// Metadata is supplied as query params so the body can remain raw APK bytes.
router.post(
  '/releases',
  requireAdmin,
  express.raw({ type: APK_CONTENT_TYPE, limit: MAX_APK_BYTES }),
  async (req, res) => {
    const versionCode = intParam(req.query.versionCode);
    const versionName = String(req.query.versionName || '').trim();
    const notes = String(req.query.notes || '').trim() || null;
    if (!versionCode || !versionName) {
      return res.status(400).json({ error: 'versionCode and versionName are required' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 1024) {
      return res.status(400).json({ error: 'Send the APK as application/vnd.android.package-archive' });
    }
    try {
      const release = await createOtaRelease({
        versionCode,
        versionName,
        notes,
        apkBytes: req.body,
        createdBy: req.user?.id || null,
      });
      try {
        await logActivity(req.user?.id || null, req.user?.username || 'system', 'radio_ota_release_uploaded', {
          releaseId: release.id,
          versionCode: release.version_code,
          versionName: release.version_name,
          apkSize: release.apk_size,
          sha256: release.sha256,
        }, null);
      } catch (e) {
        console.warn('[OTA] audit log failed:', e.message);
      }
      return res.status(201).json({ release });
    } catch (err) {
      console.error('[OTA] release upload failed:', err);
      return res.status(500).json({ error: err.message || 'Failed to store OTA release' });
    }
  }
);

router.get('/releases', requireAdmin, async (req, res) => {
  try {
    return res.json({ releases: await listOtaReleases(req.query.limit) });
  } catch (err) {
    console.error('[OTA] release list failed:', err);
    return res.status(500).json({ error: 'Failed to list OTA releases' });
  }
});

router.get('/releases/:releaseId/status', requireAdmin, async (req, res) => {
  try {
    const releaseId = intParam(req.params.releaseId);
    if (!releaseId) return res.status(400).json({ error: 'Invalid release ID' });
    return res.json({ assignments: await getOtaAssignmentSummary(releaseId) });
  } catch (err) {
    console.error('[OTA] assignment status failed:', err);
    return res.status(500).json({ error: 'Failed to load OTA status' });
  }
});

// Queue a release for selected radios or every registered radio, then wake them
// with data-only FCM. Radios without FCM remain queued and pick it up on next check.
router.post('/releases/:releaseId/push', requireAdmin, async (req, res) => {
  const releaseId = intParam(req.params.releaseId);
  if (!releaseId) return res.status(400).json({ error: 'Invalid release ID' });
  try {
    const release = await getOtaRelease(releaseId, false);
    if (!release) return res.status(404).json({ error: 'OTA release not found' });

    const allRadios = await getAllRadios();
    const requestedIds = Array.isArray(req.body?.radioIds)
      ? new Set(req.body.radioIds.map(String))
      : null;
    const targets = requestedIds
      ? allRadios.filter(r => requestedIds.has(String(r.radio_id)))
      : allRadios;
    if (!targets.length) return res.status(400).json({ error: 'No target radios found' });

    await assignReleaseToRadios(releaseId, targets.map(r => r.radio_id));

    let fcmDelivered = 0;
    let fcmFailed = 0;
    let noFcm = 0;
    await Promise.all(targets.map(async (radio) => {
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
      } catch (e) {
        fcmFailed += 1;
        console.warn(`[OTA] FCM push failed radio=${radio.radio_id}:`, e.message);
      }
    }));

    try {
      await logActivity(req.user?.id || null, req.user?.username || 'system', 'radio_ota_pushed', {
        releaseId,
        versionCode: release.version_code,
        radioIds: targets.map(r => r.radio_id),
        fcmDelivered,
        fcmFailed,
        noFcm,
      }, null);
    } catch (e) {
      console.warn('[OTA] push audit log failed:', e.message);
    }

    return res.json({
      queued: targets.length,
      release,
      delivery: { fcmDelivered, fcmFailed, noFcm },
    });
  } catch (err) {
    console.error('[OTA] push failed:', err);
    return res.status(500).json({ error: err.message || 'OTA push failed' });
  }
});

// T320 check-in. currentVersionCode is intentionally supplied by the installed
// app rather than trusted from stale server metadata.
router.get('/check', radioAuth, async (req, res) => {
  try {
    const currentVersionCode = Number(req.query.currentVersionCode) || 0;
    const pending = await getPendingOtaForRadio(req.radio.radio_id, currentVersionCode);
    if (!pending) return res.json({ updateAvailable: false });
    return res.json({
      updateAvailable: true,
      release: {
        id: pending.release_id,
        versionCode: pending.version_code,
        versionName: pending.version_name,
        sha256: pending.sha256,
        apkSize: Number(pending.apk_size),
        notes: pending.notes,
        downloadPath: `/api/radios/ota/releases/${pending.release_id}/download`,
      },
    });
  } catch (err) {
    console.error('[OTA] radio check failed:', err);
    return res.status(500).json({ error: 'OTA check failed' });
  }
});

router.get('/releases/:releaseId/download', radioAuth, async (req, res) => {
  try {
    const releaseId = intParam(req.params.releaseId);
    if (!releaseId) return res.status(400).json({ error: 'Invalid release ID' });
    const pending = await getPendingOtaForRadio(req.radio.radio_id, 0);
    if (!pending || Number(pending.release_id) !== releaseId) {
      return res.status(403).json({ error: 'This release is not assigned to this radio' });
    }
    const release = await getOtaRelease(releaseId, true);
    if (!release) return res.status(404).json({ error: 'OTA release not found' });
    res.setHeader('Content-Type', APK_CONTENT_TYPE);
    res.setHeader('Content-Length', String(release.apk_bytes.length));
    res.setHeader('X-APK-SHA256', release.sha256);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(release.apk_bytes);
  } catch (err) {
    console.error('[OTA] download failed:', err);
    return res.status(500).json({ error: 'OTA download failed' });
  }
});

router.post('/status', radioAuth, async (req, res) => {
  try {
    const releaseId = intParam(req.body?.releaseId);
    const status = String(req.body?.status || '').trim();
    const detail = req.body?.detail == null ? null : String(req.body.detail).slice(0, 1000);
    const currentVersionCode = Number(req.body?.currentVersionCode) || null;
    if (!releaseId || !status) return res.status(400).json({ error: 'releaseId and status are required' });
    const assignment = await updateOtaStatus({
      radioId: req.radio.radio_id,
      releaseId,
      status,
      detail,
      currentVersionCode,
    });
    if (!assignment) return res.status(404).json({ error: 'OTA assignment not found' });
    return res.json({ ok: true, assignment });
  } catch (err) {
    console.error('[OTA] status update failed:', err);
    return res.status(400).json({ error: err.message || 'OTA status update failed' });
  }
});

export default router;
