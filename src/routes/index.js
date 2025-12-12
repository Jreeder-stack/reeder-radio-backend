import express from 'express';
import authRouter from './authRouter.js';
import adminRouter from './adminRouter.js';
import channelsRouter from './channelsRouter.js';
import dispatchRouter from './dispatchRouter.js';

export function setupRoutes(app) {
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/dispatch', dispatchRouter);
}
