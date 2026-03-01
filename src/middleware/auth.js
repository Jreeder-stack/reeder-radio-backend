export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    console.log(`[AUTH-MW] Blocked: ${req.method} ${req.originalUrl} — no session user | sessionID=${req.sessionID?.substring(0, 8) || 'none'}... | cookie=${!!req.headers.cookie} | ip=${req.ip}`);
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
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
  next();
}
