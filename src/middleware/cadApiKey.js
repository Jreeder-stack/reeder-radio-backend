import { config } from '../config/env.js';

export function requireCadApiKey(req, res, next) {
  const apiKey = req.body?.apiKey || req.headers['x-radio-api-key'];

  if (!config.cadIntegrationKey) {
    console.error('[CAD-API-KEY] CAD_INTEGRATION_KEY environment variable is not set');
    return res.status(500).json({ error: 'CAD integration not configured' });
  }

  if (!apiKey) {
    console.log(`[CAD-API-KEY] Rejected: no API key provided | ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ error: 'API key required' });
  }

  if (apiKey !== config.cadIntegrationKey) {
    console.log(`[CAD-API-KEY] Rejected: invalid API key | ${req.method} ${req.originalUrl}`);
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

export function requireCadApiKeyOrSession(req, res, next) {
  if (req.session?.user) {
    req.user = req.session.user;
    return next();
  }

  const apiKey = req.body?.apiKey || req.headers['x-radio-api-key'];

  if (!config.cadIntegrationKey) {
    console.error('[CAD-API-KEY] CAD_INTEGRATION_KEY environment variable is not set');
    return res.status(500).json({ error: 'CAD integration not configured' });
  }

  if (!apiKey) {
    console.log(`[CAD-API-KEY] Rejected: no API key or session | ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ error: 'API key or session required' });
  }

  if (apiKey !== config.cadIntegrationKey) {
    console.log(`[CAD-API-KEY] Rejected: invalid API key | ${req.method} ${req.originalUrl}`);
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}
