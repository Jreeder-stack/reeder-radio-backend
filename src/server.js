import 'dotenv/config';
import { createServer } from 'http';
import { execSync } from 'child_process';
import app from './app.js';
import { config, validateEnv } from './config/env.js';
import { initializeDatabase, isAiDispatchEnabled, getAiDispatchChannel, getAllChannels } from './db/index.js';
import { aiDispatcherRuntimeManager } from './services/aiDispatcherRuntimeManager.js';
import { isConfigured as isAzureConfigured } from './services/azureSpeechService.js';
import { signalingService } from './services/signalingService.js';
import { installFloorIdentityHardening } from './services/signalingFloorIdentityHardening.js';
import { audioRelayService } from './services/audioRelayService.js';
import { setupRecordingTap } from './services/recordingTapService.js';
import { wsAudioBridge } from './services/wsAudioBridge.js';
import { hourlyTimeBroadcastScheduler } from './services/hourlyTimeBroadcastService.js';

let _buildVersion = 'unknown';
try {
  _buildVersion = execSync('git rev-parse --short HEAD 2>/dev/null').toString().trim();
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

  installFloorIdentityHardening(signalingService);
  signalingService.initialize(httpServer);
  audioRelayService.setSignalingService(signalingService);
  console.log('Signaling service initialized');

  const { setRadiosIo } = await import('./routes/radiosRouter.js');
  setRadiosIo(signalingService.io);

  wsAudioBridge.setSignalingService(signalingService);
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
    const profiles = await aiDispatcherRuntimeManager.initialize();
    const running = profiles.filter((profile) => profile.runtime?.state === 'connected' || profile.runtime?.state === 'starting').length;
    console.log(`[STARTUP] AI dispatcher profiles initialized: ${profiles.length} configured, ${running} running`);
  } catch (err) {
    console.error('AI dispatcher profile initialization failed:', err.message);
  }

  try {
    hourlyTimeBroadcastScheduler.start();
    const next = hourlyTimeBroadcastScheduler.getNextFireAt();
    console.log(`[STARTUP] Hourly time broadcast scheduler armed; next fire at ${next ? next.toISOString() : 'unknown'} (TZ=${process.env.TZ || 'system-default'})`);
  } catch (err) {
    console.error('[STARTUP] Failed to start hourly time broadcast scheduler:', err.message);
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    console.warn('[STARTUP] FCM push notifications DISABLED: set FIREBASE_SERVICE_ACCOUNT_JSON secret (raw JSON) or FIREBASE_SERVICE_ACCOUNT_PATH to enable device paging.');
  } else {
    console.log('[STARTUP] FCM service account credential detected.');
  }

  try {
    const apns = await import('./services/apnsService.js');
    const dbMod = await import('./db/index.js');
    if (apns.isApnsEnabled()) {
      console.log('[STARTUP] APNs push notifications enabled (host=' +
        (process.env.APNS_PRODUCTION === 'true' ? 'production' : 'sandbox') +
        ', bundle=' + process.env.APNS_BUNDLE_ID + ')');
    } else {
      console.warn('[STARTUP] APNs push notifications DISABLED: set APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, and APNS_KEY_P8 (or APNS_KEY_PATH) to enable iOS pushes.');
    }
    signalingService.onEmergencyStart(async (data) => {
      try {
        const tokens = (await dbMod.getAllApnsTokens()).map(r => r.token).filter(Boolean);
        if (tokens.length === 0) return;
        const payload = apns.buildEmergencyPayload({
          unitId: data.unitId,
          channelId: data.channelId,
          message: `EMERGENCY: Unit ${data.unitId} on ${data.channelId}`,
        });
        const result = await apns.sendApnsToTokens(tokens, payload, {
          collapseId: `emerg-${data.channelId}`,
          pushType: 'alert',
          priority: 10,
        });
        console.log(`[APNs] Emergency push sent for unit=${data.unitId} channel=${data.channelId}: success=${result.successCount} failure=${result.failureCount}`);
      } catch (err) {
        console.warn('[APNs] Emergency push failed:', err.message);
      }
    });
  } catch (err) {
    console.warn('[STARTUP] APNs init failed:', err.message);
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

const HARD_SHUTDOWN_TIMEOUT_MS = 15000;
const STEP_TIMEOUT_MS = 4000;

function withStepTimeout(label, fn) {
  let timer;
  return Promise.race([
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.error(`[SHUTDOWN] Step "${label}" error: ${err.message}`);
      })
      .finally(() => {
        clearTimeout(timer);
      }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[SHUTDOWN] Step "${label}" timed out after ${STEP_TIMEOUT_MS}ms, moving on.`);
        resolve();
      }, STEP_TIMEOUT_MS);
    }),
  ]);
}

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

    await withStepTimeout('hourly time broadcast scheduler', () => {
      console.log('[SHUTDOWN] Stopping hourly time broadcast scheduler...');
      hourlyTimeBroadcastScheduler.stop();
    });

    await withStepTimeout('AI dispatcher runtimes', async () => {
      console.log('[SHUTDOWN] Stopping AI dispatcher runtimes...');
      await aiDispatcherRuntimeManager.shutdown();
    });

    await withStepTimeout('signaling service', () => {
      console.log('[SHUTDOWN] Stopping signaling service...');
      signalingService.stop();
    });

    await withStepTimeout('WS audio bridge', () => {
      console.log('[SHUTDOWN] Stopping WebSocket audio bridge...');
      wsAudioBridge.stop();
    });

    await withStepTimeout('audio relay', () => {
      console.log('[SHUTDOWN] Stopping audio relay service...');
      audioRelayService.stop();
    });

    await withStepTimeout('HTTP server', async () => {
      console.log('[SHUTDOWN] Closing HTTP server...');
      await new Promise((resolve) => httpServer.close(() => resolve()));
    });

    await withStepTimeout('database pool', async () => {
      console.log('[SHUTDOWN] Closing database pool...');
      const pool = (await import('./db/index.js')).default;
      await pool.end();
    });

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
