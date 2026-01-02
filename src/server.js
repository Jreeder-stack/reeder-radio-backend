import 'dotenv/config';
import { createServer } from 'http';
import app from './app.js';
import { config, validateEnv } from './config/env.js';
import { initializeDatabase, isAiDispatchEnabled, getAiDispatchChannel } from './db/index.js';
import { startDispatcher, getDispatcher } from './services/aiDispatchService.js';
import { isConfigured as isAzureConfigured } from './services/azureSpeechService.js';
import { signalingService } from './services/signalingService.js';

async function start() {
  validateEnv();
  
  try {
    await initializeDatabase();
    console.log('Database ready');
  } catch (err) {
    console.error('Database initialization failed:', err);
    process.exit(1);
  }

  const httpServer = createServer(app);
  
  signalingService.initialize(httpServer);
  console.log('Signaling service initialized');

  try {
    if (!isAzureConfigured()) {
      console.log('AI Dispatcher: Azure Speech not configured, skipping auto-start');
    } else {
      const dispatcher = getDispatcher();
      if (dispatcher.isRunning) {
        console.log('AI Dispatcher: Already running, skipping auto-start');
      } else {
        const aiEnabled = await isAiDispatchEnabled();
        if (aiEnabled) {
          const dispatchChannel = await getAiDispatchChannel();
          if (dispatchChannel) {
            console.log(`Auto-starting AI Dispatcher on channel: ${dispatchChannel}`);
            await startDispatcher(dispatchChannel);
          } else {
            console.log('AI Dispatcher: No dispatch channel configured, skipping auto-start');
          }
        } else {
          console.log('AI Dispatcher: Disabled in settings, skipping auto-start');
        }
      }
    }
  } catch (err) {
    console.error('AI Dispatcher auto-start failed:', err.message);
  }
  
  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`Server running on port ${config.port}`);
    console.log(`Signaling endpoint: ws://0.0.0.0:${config.port}/signaling`);
  });
}

start().catch(console.error);
