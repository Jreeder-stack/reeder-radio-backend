import express from 'express';
import * as channelsController from '../controllers/channelsController.js';
import { requireAuthOrRadioToken } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuthOrRadioToken);

router.get('/', channelsController.getAccessibleChannels);

export default router;
