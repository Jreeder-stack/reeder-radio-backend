import 'dotenv/config';
import { createServer } from 'http';
import { execSync } from 'child_process';
import app from './app.js';
import { config, validateEnv } from './config/env.js';
import { initializeDatabase, isAiDispatchEnabled, getAiDispatchChannel, getAllChannels } from './db/index.js';
import { startDispatcher, getDispatcher } from './services/aiDispatchService.js';
import { isConfigured as isAzureConfigured } from './services/azureSpeechService.js';
import { signalingService } from './services/signalingService.js';
import { audioRelayService } from './services/audioRelayService.js';
import { setupRecordingTap } from './services/recordingTapService.js';
import { wsAudioBridge } from './services/wsAudioBridge.js';

let _buildVersion = 'unknown';
try {
  _buildVersion = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {}
const _buildTime = new Date().toISOString();
const _startTime = Date.now();
console.log(`[BUILD] version=${_buildVersion} built=${_buildTime}`);

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

  await listenWithRetry(httpServer, config.port, '0.0.0.0');
  console.log(`Server running on port ${config.port}`);

  const audioRelayPort = parseInt(process.env.AUDIO_RELAY_PORT, 10) || 5100;
  await audioRelayService.start(audioRelayPort);
  console.log(`Audio relay service started on UDP port ${audioRelayPort}`);

  signalingService.initialize(httpServer);
  audioRelayService.setSignalingService(signalingService);
  console.log('Signaling service initialized');

  wsAudioBridge.attach(httpServer);
  console.log('WebSocket audio bridge attached');

  try {
    const allChannels = await getAllChannels();
    let registered = 0;
    for (const ch of allChannels) {
      if (ch.id && ch.room_key) {
        audioRelayService.registerChannelNumeric(ch.room_key, ch.id);
        registered++;
      }
    }
    console.log(`[STARTUP] Registered ${registered} channel numeric IDs with audio relay`);
  } catch (err) {
    console.error('[STARTUP] Failed to register channel numeric IDs:', err.message);
  }

  setupRecordingTap(audioRelayService, signalingService);
  console.log('Recording tap wired to audio relay');

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

  console.log(`Signaling endpoint: ws://0.0.0.0:${config.port}/signaling`);

  setupGracefulShutdown(httpServer);
}

function listenWithRetry(server, port, host, retries = 3, delay = 3000) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && remaining > 0) {
          console.warn(`[STARTUP] Port ${port} in use, retrying in ${delay}ms (${remaining} attempts left)...`);
          try { server.close(); } catch (_) {}
          setTimeout(() => attempt(remaining - 1), delay);
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    };
    attempt(retries);
  });
}

const HARD_SHUTDOWN_TIMEOUT_MS = 8000;

function setupGracefulShutdown(httpServer) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] Received ${signal}, starting graceful shutdown...`);

    const hardShutdownTimer = setTimeout(() => {
      console.error('[SHUTDOWN] Hard shutdown timeout reached, forcing exit.');
      process.exit(1);
    }, HARD_SHUTDOWN_TIMEOUT_MS);
    hardShutdownTimer.unref();

    try {
      console.log('[SHUTDOWN] Stopping signaling service...');
      signalingService.stop();
    } catch (err) {
      console.error('[SHUTDOWN] Signaling service stop error:', err.message);
    }

    try {
      console.log('[SHUTDOWN] Stopping WebSocket audio bridge...');
      wsAudioBridge.stop();
    } catch (err) {
      console.error('[SHUTDOWN] WS audio bridge stop error:', err.message);
    }

    try {
      console.log('[SHUTDOWN] Stopping audio relay service...');
      audioRelayService.stop();
    } catch (err) {
      console.error('[SHUTDOWN] Audio relay stop error:', err.message);
    }

    try {
      console.log('[SHUTDOWN] Closing HTTP server...');
      await new Promise((resolve) => httpServer.close(() => resolve()));
    } catch (err) {
      console.error('[SHUTDOWN] HTTP server close error:', err.message);
    }

    try {
      console.log('[SHUTDOWN] Closing database pool...');
      const pool = (await import('./db/index.js')).default;
      await pool.end();
    } catch (err) {
      console.error('[SHUTDOWN] Database pool close error:', err.message);
    }

    console.log('[SHUTDOWN] Graceful shutdown complete.');
    clearTimeout(hardShutdownTimer);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('[STARTUP] Fatal error:', err);
  process.exit(1);
});
