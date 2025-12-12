import express from 'express';
import * as channelsController from '../controllers/channelsController.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', channelsController.getAccessibleChannels);

export default router;
