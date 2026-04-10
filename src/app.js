import express from 'express';
import cors from 'cors';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { execSync } from 'child_process';

import { config } from './config/env.js';
import pool from './db/index.js';
import { setupRoutes } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/auth.js';
import * as authService from './services/authService.js';

let _appBuildVersion = 'unknown';
try {
  _appBuildVersion = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {}
const _appBuildTime = new Date().toISOString();
const _appStartTime = Date.now();

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

const rateLimitCadIntegration = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' }
});
app.use('/api/cad-integration', rateLimitCadIntegration);

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

app.get('/api/radio-client.js', (req, res) => {
  const clientPath = path.join(__dirname, '..', 'public', 'radio-client.js');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(clientPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Radio client not found' });
    }
  });
});

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


app.get('/api/version', (req, res) => {
  res.json({
    version: _appBuildVersion,
    built: _appBuildTime,
    uptime: Math.round((Date.now() - _appStartTime) / 1000),
  });
});

const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
const docsPath = path.join(__dirname, '..', 'docs');

app.use('/docs', express.static(docsPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.md')) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    }
  }
}));

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
