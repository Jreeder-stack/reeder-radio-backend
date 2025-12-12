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

export default router;
