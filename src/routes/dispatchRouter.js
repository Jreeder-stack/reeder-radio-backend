import express from 'express';
import * as dispatchController from '../controllers/dispatchController.js';
import { requireAuth } from '../middleware/auth.js';
import { signalingService } from '../services/signalingService.js';

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
router.post('/notify-emergency', dispatchController.notifyEmergency);

router.get('/unit-locations', (req, res) => {
  const locations = signalingService.getTrackedLocations();
  res.json({ locations });
});

export default router;
