import express from 'express';
import * as adminController from '../controllers/adminController.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAdmin);

router.get('/users', adminController.listUsers);
router.post('/users', adminController.createUser);
router.put('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);
router.put('/users/:id/password', adminController.updateUserPassword);
router.get('/users/:id/channels', adminController.getUserChannels);
router.put('/users/:id/channels', adminController.setUserChannels);

router.get('/channels', adminController.listChannels);
router.post('/channels', adminController.createChannel);
router.put('/channels/:id', adminController.updateChannel);
router.delete('/channels/:id', adminController.deleteChannel);

router.get('/zones', adminController.listZones);
router.post('/zones', adminController.createZone);
router.put('/zones/:id', adminController.updateZone);
router.delete('/zones/:id', adminController.deleteZone);

router.get('/logs', adminController.listLogs);

router.get('/ai-dispatch', adminController.getAiDispatch);
router.put('/ai-dispatch', adminController.setAiDispatch);

router.get('/hourly-time-broadcast', adminController.getHourlyTimeBroadcast);
router.put('/hourly-time-broadcast', adminController.setHourlyTimeBroadcast);
router.post('/hourly-time-broadcast/play-now', adminController.playHourlyTimeBroadcastNow);

router.get('/audio-tuning', adminController.getAudioTuning);
router.put('/audio-tuning', adminController.setAudioTuning);
router.post('/audio-tuning/reset', adminController.resetAudioTuning);

router.get('/scanner', adminController.getScannerFeed);
router.post('/scanner', adminController.setScannerFeed);

router.get('/vm-logs', adminController.streamVmLogs);

router.get('/learning/candidates', adminController.listLearningCandidates);
router.get('/learning/pending-count', adminController.getLearningPendingCount);
router.post('/learning/candidates/:id/approve', adminController.approveLearningCandidate);
router.post('/learning/candidates/:id/reject', adminController.rejectLearningCandidate);
router.get('/learning/items', adminController.listLearningItems);
router.delete('/learning/items/:id', adminController.deleteLearningItem);

router.get('/devices', adminController.listDevices);
router.delete('/devices/:id', adminController.deleteDevice);
router.patch('/devices/:id', adminController.updateDeviceLabel);

export default router;
