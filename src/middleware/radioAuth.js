import { getRadioByToken } from '../db/index.js';

export async function radioAuth(req, res, next) {
  const token = req.headers['x-radio-token'];
  if (!token) {
    return res.status(401).json({ error: 'Radio token required' });
  }

  try {
    const radio = await getRadioByToken(token);
    if (!radio) {
      return res.status(401).json({ error: 'Invalid radio token' });
    }
    if (radio.is_locked) {
      return res.status(401).json({ error: 'RADIO_LOCKED' });
    }
    req.radio = radio;
    next();
  } catch (err) {
    console.error('[RadioAuth] Error validating token:', err);
    return res.status(500).json({ error: 'Authentication error' });
  }
}
