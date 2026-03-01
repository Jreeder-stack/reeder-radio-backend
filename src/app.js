import express from 'express';
import cors from 'cors';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

import { config } from './config/env.js';
import pool from './db/index.js';
import { setupRoutes } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/auth.js';
import * as livekitService from './services/livekitService.js';
import * as authService from './services/authService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy for Render/production (needed for rate limiting and secure cookies)
app.set('trust proxy', 1);

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

const PgSession = pgSession(session);
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'session'
  }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.nodeEnv === 'production',
    httpOnly: true,
    sameSite: config.nodeEnv === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const rateLimitAuth = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' }
});

app.use('/api/auth', rateLimitAuth);

const NOISY_ENDPOINTS = new Set(['/api/dispatch/units', '/api/cad/messages/unread', '/api/cad/pending-checks']);
const noisyCounters = {};

app.use('/api', (req, res, next) => {
  const start = Date.now();
  const sessionUser = req.session?.user;
  const sessionId = req.sessionID ? req.sessionID.substring(0, 8) + '...' : 'none';
  const cleanUrl = req.originalUrl?.split('?')[0];
  const isNoisy = NOISY_ENDPOINTS.has(cleanUrl);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const userInfo = sessionUser ? `user=${sessionUser.username}(id:${sessionUser.id})` : 'session=none';

    if (isNoisy) {
      noisyCounters[cleanUrl] = (noisyCounters[cleanUrl] || 0) + 1;
      if (noisyCounters[cleanUrl] % 60 === 1) {
        console.log(`[API] ${req.method} ${req.originalUrl} | ${userInfo} | sid=${sessionId} | ${res.statusCode} | ${duration}ms (logged 1/60)`);
      }
    } else {
      console.log(`[API] ${req.method} ${req.originalUrl} | ${userInfo} | sid=${sessionId} | ${res.statusCode} | ${duration}ms`);
    }
  });
  next();
});

setupRoutes(app);

app.post('/api/activity/log', requireAuth, async (req, res) => {
  try {
    const { action, details, channel } = req.body;
    await authService.logUserActivity(
      req.session.user.id,
      req.session.user.username,
      action,
      details,
      channel
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Activity log error:', err);
    res.status(500).json({ error: 'Failed to log activity' });
  }
});

app.get('/getToken', requireAuth, async (req, res) => {
  try {
    const { room, identity } = req.query;
    if (!room || !identity) {
      return res.status(400).json({ error: 'Room and identity required' });
    }
    
    const result = await livekitService.generateToken(identity, room);
    res.json(result);
  } catch (err) {
    console.error('Token generation error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

const clientDistPath = path.join(__dirname, '..', 'client', 'dist');

app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(path.join(clientDistPath, '.well-known', 'assetlinks.json'));
});

app.use(express.static(clientDistPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

app.get('*', (req, res) => {
  const indexPath = path.join(clientDistPath, 'index.html');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

app.use(errorHandler);

export default app;
