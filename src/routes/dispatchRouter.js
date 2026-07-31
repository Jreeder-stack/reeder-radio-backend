import express from 'express';
import * as dispatchController from '../controllers/dispatchController.js';
import { requireAuth, requireAuthOrRadioToken } from '../middleware/auth.js';
import { requireDispatcher } from '../middleware/auth.js';
import { signalingService } from '../services/signalingService.js';
import {
  createPage,
  recordPageAck,
  getPageAcks,
  getPage,
  getAllFcmTokensForUnit,
  getAllFcmTokens,
  getPagingChannelId,
  getRadioByAssignedUserId,
  getApnsTokensForUnitId,
  getAllApnsTokens,
} from '../db/index.js';
import { sendPageToTokens } from '../services/fcmService.js';
import {
  sendApnsToTokens,
  buildPagePayload,
  isApnsEnabled,
} from '../services/apnsService.js';
import {
  getDispatcherPagingLists,
  createDispatcherPagingList,
  updateDispatcherPagingList,
  deleteDispatcherPagingList,
  resolveRadioRecipients,
} from '../services/pagingRosterService.js';

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

router.post('/page/:id/ack', requireAuthOrRadioToken, async (req, res) => {
  const pageId = parseInt(req.params.id, 10);
  let radioId = req.radio?.radio_id || req.user?.radio_id || req.session?.radio_id || null;
  let unitId = req.radio?.assigned_unit_id || null;

  if (!radioId && req.user?.id) {
    try {
      const radio = await getRadioByAssignedUserId(req.user.id);
      if (radio) {
        radioId = radio.radio_id;
        unitId = radio.assigned_unit_id || null;
      }
    } catch (err) {
      console.warn('[Dispatch] Page ACK radio lookup failed:', err.message);
    }
  }

  if (!radioId) {
    return res.status(400).json({ error: 'Radio identification required' });
  }

  try {
    const page = await getPage(pageId);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    const ack = await recordPageAck(pageId, unitId, radioId);
    res.json({ success: true, ack });
  } catch (err) {
    console.error('[Dispatch] Page ACK error:', err);
    res.status(500).json({ error: 'Failed to record acknowledgment' });
  }
});

router.use(requireAuth);

router.get('/health/detailed', (req, res) => {
  res.json(signalingService.getSystemHealth());
});

router.get('/connection-stats', (req, res) => {
  res.json({ stats: signalingService.getAllConnectionStats() });
});

router.post('/connection-time', (req, res) => {
  const { unitId, channelId, durationMs } = req.body;
  const resolvedUnitId = unitId || req.session?.unitId || req.user?.unit_id || req.user?.username;
  if (!resolvedUnitId || !channelId || typeof durationMs !== 'number') {
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
  res.json({ locations: signalingService.getTrackedLocations() });
});

router.get('/paging-lists', requireDispatcher, async (req, res) => {
  try {
    res.json({ lists: await getDispatcherPagingLists() });
  } catch (err) {
    console.error('[Dispatch] Paging lists fetch error:', err);
    res.status(500).json({ error: 'Failed to load paging lists' });
  }
});

router.post('/paging-lists', requireDispatcher, async (req, res) => {
  try {
    const list = await createDispatcherPagingList(
      req.body.name,
      req.body.radioIds,
      req.user?.id || null
    );
    res.status(201).json({ list, lists: await getDispatcherPagingLists() });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create paging list' });
  }
});

router.patch('/paging-lists/:id', requireDispatcher, async (req, res) => {
  try {
    await updateDispatcherPagingList(req.params.id, req.body.name, req.body.radioIds);
    res.json({ success: true, lists: await getDispatcherPagingLists() });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update paging list' });
  }
});

router.delete('/paging-lists/:id', requireDispatcher, async (req, res) => {
  try {
    const deleted = await deleteDispatcherPagingList(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Paging list not found' });
    res.json({ success: true, lists: await getDispatcherPagingLists() });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to delete paging list' });
  }
});

router.post('/page', requireDispatcher, async (req, res) => {
  const { message, targetType, targetId, radioIds } = req.body;
  const sender = req.user?.username || req.user?.unit_id || 'DISPATCH';

  if (!message || !targetType) {
    return res.status(400).json({ error: 'message and targetType are required' });
  }
  if (!['unit', 'units', 'list', 'channel', 'all'].includes(targetType)) {
    return res.status(400).json({ error: 'Unsupported page target type' });
  }
  if (targetType === 'units' && (!Array.isArray(radioIds) || radioIds.length === 0)) {
    return res.status(400).json({ error: 'At least one radio must be selected' });
  }
  if (targetType !== 'units' && !targetId) {
    return res.status(400).json({ error: 'targetId is required' });
  }

  try {
    const storedTargetId = targetType === 'units'
      ? `${radioIds.length} selected radios`
      : String(targetId);
    const page = await createPage(message.trim(), sender, targetType, storedTargetId);
    const pagingChannelId = await getPagingChannelId();

    if (targetType === 'units' || targetType === 'list') {
      const recipients = await resolveRadioRecipients({
        radioIds: targetType === 'units' ? radioIds : undefined,
        listId: targetType === 'list' ? targetId : undefined,
      });

      const fcmTokens = [...new Set(recipients.flatMap(r => r.fcmTokens))];
      const apnsTokens = [...new Set(recipients.flatMap(r => r.apnsTokens))];
      const fcmResult = fcmTokens.length
        ? await sendPageToTokens(fcmTokens, page.id, message.trim(), sender, pagingChannelId)
        : { successCount: 0, failureCount: 0 };
      const apnsResult = apnsTokens.length
        ? await sendApnsToTokens(
            apnsTokens,
            buildPagePayload({ pageId: page.id, message: message.trim(), sender, pagingChannelId }),
            { collapseId: `page-${page.id}`, pushType: 'alert', priority: 10 }
          )
        : { successCount: 0, failureCount: 0 };

      return res.json({
        page,
        fcm: { successCount: fcmResult.successCount, failureCount: fcmResult.failureCount },
        apns: { successCount: apnsResult.successCount, failureCount: apnsResult.failureCount },
        targetedDeviceCount: fcmTokens.length + apnsTokens.length,
        targetedUnits: recipients.map(r => ({
          radioPk: r.radioPk,
          radioId: r.radioId,
          unitId: r.unitId,
          hasDeliveryToken: r.fcmTokens.length > 0 || r.apnsTokens.length > 0,
        })),
      });
    }

    let tokenRows = [];
    if (targetType === 'unit') {
      tokenRows = await getAllFcmTokensForUnit(targetId);
    } else {
      tokenRows = await getAllFcmTokens();
    }
    const fcmTokens = [...new Set(tokenRows.map(r => r.fcm_token).filter(Boolean))];
    const fcmResult = fcmTokens.length
      ? await sendPageToTokens(fcmTokens, page.id, message.trim(), sender, pagingChannelId)
      : { successCount: 0, failureCount: 0 };

    const apnsTokenRows = targetType === 'unit'
      ? await getApnsTokensForUnitId(targetId)
      : await getAllApnsTokens();
    const apnsTokens = [...new Set(apnsTokenRows.map(r => r.token).filter(Boolean))];
    const apnsResult = apnsTokens.length
      ? await sendApnsToTokens(
          apnsTokens,
          buildPagePayload({ pageId: page.id, message: message.trim(), sender, pagingChannelId }),
          { collapseId: `page-${page.id}`, pushType: 'alert', priority: 10 }
        )
      : { successCount: 0, failureCount: 0 };

    res.json({
      page,
      fcm: { successCount: fcmResult.successCount, failureCount: fcmResult.failureCount },
      apns: { successCount: apnsResult.successCount, failureCount: apnsResult.failureCount },
      targetedDeviceCount: fcmTokens.length + apnsTokens.length,
      targetedUnits: tokenRows.map(r => ({ unitId: r.unit_identity || r.radio_id, radioId: r.radio_id, hasDeliveryToken: true })),
      apnsEnabled: isApnsEnabled(),
    });
  } catch (err) {
    console.error('[Dispatch] Page send error:', err);
    res.status(500).json({ error: 'Failed to send page' });
  }
});

router.get('/page/:id/acks', requireAuth, async (req, res) => {
  const pageId = parseInt(req.params.id, 10);
  try {
    res.json({ acks: await getPageAcks(pageId) });
  } catch (err) {
    console.error('[Dispatch] Page ACKs fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch acknowledgments' });
  }
});

export default router;
