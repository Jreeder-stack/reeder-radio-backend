import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

router.get('/config', (req, res) => {
  const audioRelayPort = parseInt(process.env.AUDIO_RELAY_PORT, 10) || 5100;
  const audioRelayHost = process.env.AUDIO_RELAY_HOST || req.hostname;
  const transportMode = process.env.RADIO_TRANSPORT_MODE || 'custom-radio';
  const useTls = process.env.RADIO_USE_TLS
    ? process.env.RADIO_USE_TLS === 'true'
    : process.env.NODE_ENV === 'production';

  let signalingUrl;
  if (process.env.RADIO_SIGNALING_URL) {
    signalingUrl = process.env.RADIO_SIGNALING_URL;
  } else {
    const scheme = useTls ? 'https' : 'http';
    const hostHeader = req.get('host') || audioRelayHost;
    signalingUrl = `${scheme}://${hostHeader}`;
  }

  res.json({
    transportMode,
    signalingUrl,
    audioRelayHost,
    audioRelayPort,
    useTls,
  });
});

export default router;
