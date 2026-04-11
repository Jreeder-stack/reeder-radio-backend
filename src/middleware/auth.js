import { getRadioByToken, getUserById } from '../db/index.js';

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    console.log(`[AUTH-MW] Blocked: ${req.method} ${req.originalUrl} — no session user | sessionID=${req.sessionID?.substring(0, 8) || 'none'}... | cookie=${!!req.headers.cookie} | ip=${req.ip}`);
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = req.session.user;
  next();
}

export async function requireAuthOrRadioToken(req, res, next) {
  if (req.session?.user) {
    req.user = req.session.user;
    return next();
  }

  const radioToken = req.headers['x-radio-token'];
  if (radioToken) {
    try {
      const radio = await getRadioByToken(radioToken);
      if (radio && !radio.is_locked) {
        req.radio = radio;
        if (radio.assigned_unit_id) {
          const user = await getUserById(radio.assigned_unit_id);
          req.user = user || { id: radio.assigned_unit_id, role: 'user', username: `radio:${radio.radio_id}` };
        } else {
          req.user = { id: null, role: 'user', username: `radio:${radio.radio_id}` };
        }
        return next();
      }
    } catch (err) {
      console.error('[AUTH-MW] Radio token lookup error:', err);
    }
  }

  console.log(`[AUTH-MW] Blocked: ${req.method} ${req.originalUrl} — no session/radio-token | sessionID=${req.sessionID?.substring(0, 8) || 'none'}... | cookie=${!!req.headers.cookie} | ip=${req.ip}`);
  return res.status(401).json({ error: 'Not authenticated' });
}

export function requireAdmin(req, res, next) {
  if (!req.session?.user) {
    console.log(`[AUTH-MW] Blocked (admin): ${req.method} ${req.originalUrl} — no session user`);
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.user.role !== 'admin') {
    console.log(`[AUTH-MW] Blocked (admin): ${req.method} ${req.originalUrl} — user="${req.session.user.username}" role=${req.session.user.role}`);
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = req.session.user;
  next();
}

export function requireDispatcher(req, res, next) {
  if (!req.session?.user) {
    console.log(`[AUTH-MW] Blocked (dispatcher): ${req.method} ${req.originalUrl} — no session user`);
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!req.session.user.is_dispatcher && req.session.user.role !== 'admin') {
    console.log(`[AUTH-MW] Blocked (dispatcher): ${req.method} ${req.originalUrl} — user="${req.session.user.username}" role=${req.session.user.role} is_dispatcher=${req.session.user.is_dispatcher}`);
    return res.status(403).json({ error: 'Dispatcher access required' });
  }
  req.user = req.session.user;
  next();
}
