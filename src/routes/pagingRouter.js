import express from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireDispatcher } from '../middleware/auth.js';
import { radioAuth } from '../middleware/radioAuth.js';
import {
  listPagingTones,
  savePagingTone,
  activatePagingTone,
  deletePagingTone,
  getActivePagingTone,
  getPagingChannelId,
  setPagingChannelId,
  getAllChannels,
} from '../db/index.js';

const router = express.Router();

const ALLOWED_TONE_EXTENSIONS = /\.(mp3|wav|ogg|oga|aac|m4a|flac|wma)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const name = file.originalname || '';
    const hasAllowedExt = ALLOWED_TONE_EXTENSIONS.test(name);
    const isAudioMime = mime.startsWith('audio/') || mime === 'application/ogg';
    const isGenericMime = mime === 'application/octet-stream' || mime === '';
    if (isAudioMime || (isGenericMime && hasAllowedExt) || hasAllowedExt) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported audio format. Please upload MP3, WAV, OGG, AAC, M4A, FLAC, or WMA.'));
    }
  },
});

function runUploadMiddleware(req, res, next) {
  upload.single('tone')(req, res, (err) => {
    if (err) {
      console.error('[Paging] Upload middleware error:', err.message);
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}

router.get('/active', async (req, res) => {
  try {
    const tone = await getActivePagingTone();
    if (!tone || !tone.audio_data) {
      return res.status(404).json({ error: 'No active paging tone' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(tone.audio_data);
  } catch (err) {
    console.error('[Paging] Get active tone error:', err);
    res.status(500).json({ error: 'Failed to get active tone' });
  }
});

router.use(requireAuth);

router.get('/', requireAdmin, async (req, res) => {
  try {
    const tones = await listPagingTones();
    res.json({ tones });
  } catch (err) {
    console.error('[Paging] List tones error:', err);
    res.status(500).json({ error: 'Failed to list tones' });
  }
});

router.post('/upload', requireAdmin, runUploadMiddleware, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }
    const name = req.body.name || req.file.originalname;
    const tone = await savePagingTone(name, req.file.buffer);
    res.status(201).json({ tone });
  } catch (err) {
    console.error('[Paging] Upload tone error:', err);
    res.status(500).json({ error: 'Failed to upload tone' });
  }
});

router.patch('/:id/activate', requireAdmin, async (req, res) => {
  try {
    const tone = await activatePagingTone(parseInt(req.params.id, 10));
    if (!tone) return res.status(404).json({ error: 'Tone not found' });
    res.json({ tone });
  } catch (err) {
    console.error('[Paging] Activate tone error:', err);
    res.status(500).json({ error: 'Failed to activate tone' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const tone = await deletePagingTone(parseInt(req.params.id, 10));
    if (!tone) return res.status(404).json({ error: 'Tone not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Paging] Delete tone error:', err);
    res.status(500).json({ error: 'Failed to delete tone' });
  }
});

router.get('/channel', requireAuth, async (req, res) => {
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
