import 'dotenv/config';
import app from './app.js';
import { config, validateEnv } from './config/env.js';
import { initializeDatabase, isAiDispatchEnabled, getAllChannels } from './db/index.js';
import { startDispatcher, getDispatcher } from './services/aiDispatchService.js';
import { isConfigured as isAzureConfigured } from './services/azureSpeechService.js';

async function start() {
  validateEnv();
  
  try {
    await initializeDatabase();
    console.log('Database ready');
  } catch (err) {
    console.error('Database initialization failed:', err);
    process.exit(1);
  }

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
          const channels = await getAllChannels();
          const enabledChannelNames = channels.filter(c => c.enabled).map(c => c.name);
          if (enabledChannelNames.length > 0) {
            console.log('Auto-starting AI Dispatcher...');
            await startDispatcher(enabledChannelNames);
          } else {
            console.log('AI Dispatcher: No enabled channels, skipping auto-start');
          }
        } else {
          console.log('AI Dispatcher: Disabled in settings, skipping auto-start');
        }
      }
    }
  } catch (err) {
    console.error('AI Dispatcher auto-start failed:', err.message);
  }
  
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Server running on port ${config.port}`);
  });
}

start().catch(console.error);
