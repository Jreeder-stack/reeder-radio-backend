import express from 'express';
import * as dispatchController from '../controllers/dispatchController.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

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

export default router;
