import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  getPagingChannelId,
  setPagingChannelId,
  getAllChannels,
} from '../db/index.js';

const router = express.Router();

router.use(requireAuth);

router.get('/channel', async (req, res) => {
  try {
    const channelId = await getPagingChannelId();
    const channels = await getAllChannels();
    const channel = channelId ? channels.find(c => String(c.id) === String(channelId)) : null;
    res.json({ channelId: channelId || null, channel: channel || null, channels });
  } catch (err) {
    console.error('[Paging] Get channel error:', err);
    res.status(500).json({ error: 'Failed to get paging channel' });
  }
});

router.put('/channel', requireAdmin, async (req, res) => {
  try {
    const { channelId } = req.body;
    await setPagingChannelId(channelId);
    res.json({ success: true, channelId });
  } catch (err) {
    console.error('[Paging] Set channel error:', err);
    res.status(500).json({ error: 'Failed to set paging channel' });
  }
});

export default router;
