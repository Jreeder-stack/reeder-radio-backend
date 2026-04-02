import express from 'express';
import { requireCadApiKey, requireCadApiKeyOrSession } from '../middleware/cadApiKey.js';
import * as cadIntegrationController from '../controllers/cadIntegrationController.js';

const router = express.Router();

router.post('/verify-user', requireCadApiKey, cadIntegrationController.verifyUser);
router.get('/zones', requireCadApiKeyOrSession, cadIntegrationController.getZones);
router.get('/channels', requireCadApiKeyOrSession, cadIntegrationController.getChannels);
router.get('/unit/:unitId/zones', requireCadApiKey, cadIntegrationController.getUnitZones);
router.get('/unit/:unitId/channels', requireCadApiKey, cadIntegrationController.getUnitChannels);
router.get('/ptt-status', requireCadApiKey, cadIntegrationController.getPttStatus);
router.get('/units', requireCadApiKey, cadIntegrationController.getActiveUnits);

export default router;
