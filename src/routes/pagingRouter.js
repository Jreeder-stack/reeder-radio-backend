import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  getPagingChannelId,
  setPagingChannelId,
  getAllChannels,
  getAllPagingLists,
  getPagingListByType,
  getPagingListMembers,
  addPagingListMember,
  removePagingListMember,
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

router.get('/lists', requireAdmin, async (req, res) => {
  try {
    const lists = await getAllPagingLists();
    res.json({ lists });
  } catch (err) {
    console.error('[Paging] List paging lists error:', err);
    res.status(500).json({ error: 'Failed to list paging lists' });
  }
});

router.get('/lists/:listType/members', requireAdmin, async (req, res) => {
  try {
    const { listType } = req.params;
    const list = await getPagingListByType(listType);
    if (!list) return res.status(404).json({ error: 'Unknown paging list type' });
    const members = await getPagingListMembers(listType);
    res.json({ list, members });
  } catch (err) {
    console.error('[Paging] Get paging list members error:', err);
    res.status(500).json({ error: 'Failed to get paging list members' });
  }
});

router.post('/lists/:listType/members', requireAdmin, async (req, res) => {
  try {
    const { listType } = req.params;
    const { userIds, userId } = req.body;
    const list = await getPagingListByType(listType);
    if (!list) return res.status(404).json({ error: 'Unknown paging list type' });

    const ids = Array.isArray(userIds) ? userIds : (userId != null ? [userId] : []);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'userId or userIds is required' });
    }
    const parsedIds = [];
    for (const id of ids) {
      const parsed = parseInt(id, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        return res.status(400).json({ error: `Invalid userId: ${id}` });
      }
      parsedIds.push(parsed);
    }
    for (const parsed of parsedIds) {
      await addPagingListMember(listType, parsed);
    }
    const members = await getPagingListMembers(listType);
    res.json({ list, members });
  } catch (err) {
    console.error('[Paging] Add paging list member error:', err);
    res.status(500).json({ error: 'Failed to add paging list member(s)' });
  }
});

router.delete('/lists/:listType/members/:userId', requireAdmin, async (req, res) => {
  try {
    const { listType, userId } = req.params;
    const list = await getPagingListByType(listType);
    if (!list) return res.status(404).json({ error: 'Unknown paging list type' });
    const parsed = parseInt(userId, 10);
    if (Number.isNaN(parsed)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }
    await removePagingListMember(listType, parsed);
    const members = await getPagingListMembers(listType);
    res.json({ list, members });
  } catch (err) {
    console.error('[Paging] Remove paging list member error:', err);
    res.status(500).json({ error: 'Failed to remove paging list member' });
  }
});

export default router;
