import express from 'express';
import authRouter from './authRouter.js';
import adminRouter from './adminRouter.js';
import channelsRouter from './channelsRouter.js';
import dispatchRouter from './dispatchRouter.js';
import locationRouter from './locationRouter.js';
import messagesRouter from './messagesRouter.js';
import cadRouter from './cadRouter.js';
import cadIntegrationRouter from './cadIntegrationRouter.js';
import unitRouter from './unitRouter.js';
import pttRouter from './pttRoutes.js';
import radioConfigRouter from './radioConfigRouter.js';
import recordingLogsRouter from './recordingLogsRouter.js';

export function setupRoutes(app) {
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/dispatch', dispatchRouter);
  app.use('/api/location', locationRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/cad', cadRouter);
  app.use('/api/cad-integration', cadIntegrationRouter);
  app.use('/api/unit', unitRouter);
  app.use('/api/ptt', pttRouter);
  app.use('/api/radio', radioConfigRouter);
  app.use('/api/recording-logs', recordingLogsRouter);
}
