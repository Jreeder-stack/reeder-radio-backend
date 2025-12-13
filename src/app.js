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
app.use(express.static(clientDistPath));

app.get('*', (req, res) => {
  const indexPath = path.join(clientDistPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

app.use(errorHandler);

export default app;
