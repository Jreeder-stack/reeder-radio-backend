import express from 'express';
import * as dispatchController from '../controllers/dispatchController.js';
import { requireAuth } from '../middleware/auth.js';
import { requireDispatcher } from '../middleware/auth.js';
import { signalingService } from '../services/signalingService.js';
import { radioAuth } from '../middleware/radioAuth.js';
import {
  createPage,
  recordPageAck,
  getPageAcks,
  getPage,
  getAllFcmTokensForUnit,
  getAllFcmTokens,
  getPagingChannelId,
} from '../db/index.js';
import { sendPageToTokens } from '../services/fcmService.js';

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

router.use(requireAuth);

router.get('/health/detailed', (req, res) => {
  const health = signalingService.getSystemHealth();
  res.json(health);
});

router.get('/connection-stats', (req, res) => {
  const stats = signalingService.getAllConnectionStats();
  res.json({ stats });
});

router.post('/connection-time', (req, res) => {
  const { unitId, channelId, durationMs } = req.body;
  
  const resolvedUnitId = unitId || req.session?.unitId || req.user?.unit_id || req.user?.username;
  
  if (!resolvedUnitId || !channelId || typeof durationMs !== 'number') {
    console.warn('[Connection-Time] Rejected: missing unitId, channelId, or invalid durationMs', { unitId, channelId, durationMs });
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  signalingService.recordConnectionTime(resolvedUnitId, channelId, durationMs);
  res.json({ success: true });
});

router.get('/units', dispatchController.getUnits);
router.post('/unit/update', dispatchController.updateUnit);
router.post('/units/:id/emergency', dispatchController.toggleEmergency);
router.post('/emergency/ack', dispatchController.acknowledgeEmergency);
router.post('/emergency/reset', dispatchController.resetEmergency);

router.get('/monitor/:dispatcherId', dispatchController.getMonitorSet);
router.post('/monitor/:dispatcherId', dispatchController.setMonitorSet);

router.get('/channels', dispatchController.getChannels);
router.post('/channels', dispatchController.createChannel);
router.patch('/channels/:id', dispatchController.updateChannel);

router.get('/patches', dispatchController.getPatches);
router.post('/patches', dispatchController.createPatch);
router.patch('/patches/:id', dispatchController.updatePatch);

router.get('/events', dispatchController.getEvents);

router.post('/notify-join', dispatchController.notifyJoin);
router.post('/notify-ptt', dispatchController.notifyPtt);
router.post('/notify-emergency', dispatchController.notifyEmergency);

router.get('/unit-locations', (req, res) => {
  const locations = signalingService.getTrackedLocations();
  res.json({ locations });
});

router.post('/page', requireDispatcher, async (req, res) => {
  const { message, targetType, targetId } = req.body;
  const sender = req.user?.username || req.user?.unit_id || 'DISPATCH';

  if (!message || !targetType || !targetId) {
    return res.status(400).json({ error: 'message, targetType, and targetId are required' });
  }
  if (!['unit', 'channel', 'all'].includes(targetType)) {
    return res.status(400).json({ error: 'targetType must be unit, channel, or all' });
  }

  try {
    const page = await createPage(message, sender, targetType, targetId);
    const pagingChannelId = await getPagingChannelId();

    let tokenRows = [];
    if (targetType === 'unit') {
      tokenRows = await getAllFcmTokensForUnit(targetId);
      console.log(`[Dispatch] Page to unit "${targetId}": found ${tokenRows.length} FCM token(s) | pageId=${page.id} | sender=${sender}`);
    } else {
      tokenRows = await getAllFcmTokens();
      console.log(`[Dispatch] Page to ${targetType} "${targetId}": found ${tokenRows.length} FCM token(s) across all units | pageId=${page.id} | sender=${sender}`);
    }

    if (tokenRows.length === 0) {
      console.warn(`[Dispatch] No FCM tokens found for targetType="${targetType}" targetId="${targetId}" — page will not be delivered via FCM`);
    }

    const tokens = tokenRows.map(r => r.fcm_token);
    const fcmResult = await sendPageToTokens(tokens, page.id, message, sender, pagingChannelId);
    console.log(`[Dispatch] FCM result for pageId=${page.id}: successCount=${fcmResult.successCount} failureCount=${fcmResult.failureCount}`);

    res.json({
      page,
      fcm: { successCount: fcmResult.successCount, failureCount: fcmResult.failureCount },
      targetedDeviceCount: tokenRows.length,
      targetedUnits: tokenRows.map(r => ({ unitId: r.unit_identity || r.radio_id, radioId: r.radio_id })),
    });
  } catch (err) {
    console.error('[Dispatch] Page send error:', err);
    res.status(500).json({ error: 'Failed to send page' });
  }
});

router.post('/page/:id/ack', radioAuth, async (req, res) => {
  const pageId = parseInt(req.params.id, 10);
  const radioId = req.radio?.radio_id;
  const unitId = req.body?.unitId || req.radio?.assigned_unit_id || null;

  if (!radioId) return res.status(400).json({ error: 'Radio identification required' });

  try {
    console.log('[Dispatch] Page ACK arrived: pageId=' + pageId + ' radio=' + radioId + ' unit=' + unitId);
    const page = await getPage(pageId);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const ack = await recordPageAck(pageId, unitId, radioId);
    console.log('[Dispatch] Page ACK recorded: pageId=' + pageId + ' radio=' + radioId + ' unit=' + unitId);
    res.json({ success: true, ack });
  } catch (err) {
    console.error('[Dispatch] Page ACK error:', err);
    res.status(500).json({ error: 'Failed to record acknowledgment' });
  }
});

router.get('/page/:id/acks', requireAuth, async (req, res) => {
  const pageId = parseInt(req.params.id, 10);
  try {
    const acks = await getPageAcks(pageId);
    res.json({ acks });
  } catch (err) {
    console.error('[Dispatch] Page ACKs fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch acknowledgments' });
  }
});

export default router;
