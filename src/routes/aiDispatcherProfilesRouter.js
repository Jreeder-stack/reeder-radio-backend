import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { aiDispatcherRuntimeManager } from '../services/aiDispatcherRuntimeManager.js';

const router = express.Router();
router.use(requireAdmin);

function sendError(res, error) {
  console.error('[AI-PROFILES]', error);
  res.status(error.statusCode || 500).json({ error: error.message || 'AI dispatcher profile operation failed' });
}

router.get('/catalog', async (_req, res) => {
  try { res.json(await aiDispatcherRuntimeManager.getCatalog()); }
  catch (error) { sendError(res, error); }
});

router.get('/', async (_req, res) => {
  try { res.json({ profiles: await aiDispatcherRuntimeManager.listProfilesWithStatus() }); }
  catch (error) { sendError(res, error); }
});

router.post('/', async (req, res) => {
  try { res.status(201).json({ profile: await aiDispatcherRuntimeManager.createProfile(req.body || {}) }); }
  catch (error) { sendError(res, error); }
});

router.put('/:id', async (req, res) => {
  try { res.json({ profile: await aiDispatcherRuntimeManager.updateProfile(req.params.id, req.body || {}) }); }
  catch (error) { sendError(res, error); }
});

router.delete('/:id', async (req, res) => {
  try { await aiDispatcherRuntimeManager.deleteProfile(req.params.id); res.json({ success: true }); }
  catch (error) { sendError(res, error); }
});

router.post('/:id/start', async (req, res) => {
  try { await aiDispatcherRuntimeManager.startProfile(req.params.id); res.json({ success: true }); }
  catch (error) { sendError(res, error); }
});

router.post('/:id/stop', async (req, res) => {
  try { await aiDispatcherRuntimeManager.stopProfile(req.params.id); res.json({ success: true }); }
  catch (error) { sendError(res, error); }
});

router.post('/:id/restart', async (req, res) => {
  try { await aiDispatcherRuntimeManager.restartProfile(req.params.id); res.json({ success: true }); }
  catch (error) { sendError(res, error); }
});

export default router;
