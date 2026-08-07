import express from 'express';
import authRouter from './authRouter.js';
import adminRouter from './adminRouter.js';
import channelsRouter from './channelsRouter.js';
import zonesRouter from './zonesRouter.js';
import phoneDispatchEndpointRouter from './phoneDispatchEndpointRouter.js';
import dispatchRouter from './dispatchRouter.js';
import locationRouter from './locationRouter.js';
import messagesRouter from './messagesRouter.js';
import cadRouter from './cadRouter.js';
import cadIntegrationRouter from './cadIntegrationRouter.js';
import unitRouter from './unitRouter.js';
import pttRouter from './pttRoutes.js';
import radioConfigRouter from './radioConfigRouter.js';
import recordingLogsRouter from './recordingLogsRouter.js';
import phoneRadioEndpointRouter from './phoneRadioEndpointRouter.js';
import radiosRouter from './radiosRouter.js';
import pagingRouter from './pagingRouter.js';
import devicesRouter from './devicesRouter.js';
import aiDispatcherProfilesRouter from './aiDispatcherProfilesRouter.js';

export function setupRoutes(app) {
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/admin/ai-dispatchers', aiDispatcherProfilesRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/zones', zonesRouter);
  // Must run before the legacy dispatch router so a session-authenticated
  // phone ACK is attributed to its physical radio endpoint, not whichever
  // radio for the user happened to be seen most recently.
  app.use('/api/dispatch', phoneDispatchEndpointRouter);
  app.use('/api/dispatch', dispatchRouter);
  app.use('/api/location', locationRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/cad', cadRouter);
  app.use('/api/cad-integration', cadIntegrationRouter);
  app.use('/api/unit', unitRouter);
  app.use('/api/ptt', pttRouter);
  app.use('/api/radio', radioConfigRouter);
  app.use('/api/recording-logs', recordingLogsRouter);
  // Must run before the legacy radios router so authenticated Android phones
  // register/update their own endpoint instead of overwriting a user's T320 FCM token.
  app.use('/api/radios', phoneRadioEndpointRouter);
  app.use('/api/radios', radiosRouter);
  app.use('/api/paging-tone', pagingRouter);
  app.use('/api/devices', devicesRouter);
}
