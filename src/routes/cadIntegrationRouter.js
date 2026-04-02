import express from 'express';
import { requireCadApiKey, requireCadApiKeyOrSession } from '../middleware/cadApiKey.js';
import * as cadIntegrationController from '../controllers/cadIntegrationController.js';

const router = express.Router();

router.post('/verify-user', requireCadApiKey, cadIntegrationController.verifyUser);
router.get('/zones', requireCadApiKeyOrSession, cadIntegrationController.getZones);
router.get('/channels', requireCadApiKeyOrSession, cadIntegrationController.getChannels);

export default router;
