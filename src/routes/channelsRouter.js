import express from 'express';
import * as channelsController from '../controllers/channelsController.js';
import { requireAuthOrRadioToken } from '../middleware/auth.js';
import { radioAuth } from '../middleware/radioAuth.js';

const router = express.Router();

// Prefer a physical radio's token over a stale browser cookie. An HD760
// must never inherit an earlier logged-in admin user's channel list.
router.use((req, res, next) => req.headers['x-radio-token']
  ? radioAuth(req, res, next)
  : requireAuthOrRadioToken(req, res, next));

router.get('/', channelsController.getAccessibleChannels);
router.get('/:id/announcement', channelsController.getChannelAnnouncement);

export default router;
