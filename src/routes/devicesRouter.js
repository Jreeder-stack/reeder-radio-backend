import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  upsertApnsToken,
  deleteApnsTokenForUser,
} from '../db/index.js';

const router = express.Router();

router.post('/apns-token', requireAuth, async (req, res) => {
  const { token, bundleId, environment } = req.body || {};
  if (!token || typeof token !== 'string' || !/^[0-9a-fA-F]{40,}$/.test(token)) {
    return res.status(400).json({ error: 'token is required and must be a hex device token' });
  }
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'No user id on session' });
  }

  const env = environment === 'sandbox' ? 'sandbox' : 'production';

  try {
    const row = await upsertApnsToken(userId, token, bundleId || null, env);
    console.log(
      `[Devices] APNs token registered: user_id=${userId} username=${req.user?.username} env=${env} token=${token.slice(0, 12)}...`
    );
    return res.json({ success: true, id: row.id });
  } catch (err) {
    console.error('[Devices] APNs token upsert error:', err);
    return res.status(500).json({ error: 'Failed to store APNs token' });
  }
});

router.delete('/apns-token', requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token is required' });
  }
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'No user id on session' });
  }
  try {
    const removed = await deleteApnsTokenForUser(userId, token);
    console.log(
      `[Devices] APNs token removed: user_id=${userId} username=${req.user?.username} removed=${removed} token=${token.slice(0, 12)}...`
    );
    return res.json({ success: true, removed });
  } catch (err) {
    console.error('[Devices] APNs token delete error:', err);
    return res.status(500).json({ error: 'Failed to delete APNs token' });
  }
});

export default router;
