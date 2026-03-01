import 'dotenv/config';
import { createServer } from 'http';
import app from './app.js';
import { config, validateEnv } from './config/env.js';
import { initializeDatabase, isAiDispatchEnabled, getAiDispatchChannel, getAllChannels } from './db/index.js';
import { startDispatcher, getDispatcher } from './services/aiDispatchService.js';
import { isConfigured as isAzureConfigured } from './services/azureSpeechService.js';
import { signalingService } from './services/signalingService.js';

async function start() {
  validateEnv();
  
  try {
    await initializeDatabase();
    console.log('[STARTUP] Database schema initialized');
    
    const pool = (await import('./db/index.js')).default;
    try {
      const [usersResult, channelsResult, zonesResult, sessionsResult] = await Promise.all([
        pool.query('SELECT COUNT(*) as count FROM users'),
        pool.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE enabled = true) as enabled FROM channels'),
        pool.query('SELECT COUNT(*) as count FROM zones'),
        pool.query('SELECT COUNT(*) as count FROM session')
      ]);
      console.log(`[STARTUP] DB State: ${usersResult.rows[0].count} users, ${channelsResult.rows[0].total} channels (${channelsResult.rows[0].enabled} enabled), ${zonesResult.rows[0].count} zones, ${sessionsResult.rows[0].count} active sessions`);
      
      if (parseInt(channelsResult.rows[0].total) === 0) {
        console.log('[STARTUP] WARNING: No channels in database! Users will see "No channels available"');
      }
      if (parseInt(usersResult.rows[0].count) === 0) {
        console.log('[STARTUP] WARNING: No users in database! Nobody can log in');
      }
      
      const channelsList = await pool.query('SELECT id, name, zone, enabled, COALESCE(zone, \'Default\') || \'__\' || name AS room_key FROM channels ORDER BY zone, name');
      if (channelsList.rows.length > 0) {
        console.log(`[STARTUP] Channels list:`);
        channelsList.rows.forEach(ch => {
          console.log(`  [${ch.enabled ? 'ON ' : 'OFF'}] id=${ch.id} "${ch.name}" zone="${ch.zone}" room_key="${ch.room_key}"`);
        });
      }
    } catch (countErr) {
      console.error('[STARTUP] Could not query DB state:', countErr.message);
    }
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
            const allChannels = await getAllChannels();
            const channelData = allChannels.find(ch => ch.room_key === dispatchChannel || ch.name === dispatchChannel);
            const roomKey = channelData?.room_key || dispatchChannel;
            console.log(`Auto-starting AI Dispatcher on channel: ${dispatchChannel} (room: ${roomKey})`);
            await startDispatcher(dispatchChannel, roomKey);
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
