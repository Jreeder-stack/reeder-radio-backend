import { signalingService } from './signalingService.js';
import { updateRadioLastSeen } from '../db/index.js';

const HEARTBEAT_INTERVAL_MS = 45000;

let heartbeatTimer = null;
let heartbeatRunning = false;

async function persistConnectedRadioHeartbeats() {
  if (heartbeatRunning) return;
  heartbeatRunning = true;

  try {
    const sockets = signalingService.io?.sockets?.sockets;
    if (!sockets || sockets.size === 0) return;

    const radioIds = new Set();
    for (const [, socket] of sockets) {
      if (!socket.connected || !socket.isRadioDevice || !socket.radioId) continue;
      radioIds.add(String(socket.radioId));
    }

    if (radioIds.size === 0) return;

    const results = await Promise.allSettled(
      Array.from(radioIds, (radioId) => updateRadioLastSeen(radioId))
    );

    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) {
      console.warn(`[RadioHeartbeat] ${failures.length}/${results.length} last_seen updates failed`);
    }
  } catch (err) {
    console.warn('[RadioHeartbeat] Heartbeat sweep failed:', err.message);
  } finally {
    heartbeatRunning = false;
  }
}

export function startRadioHeartbeatService() {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(persistConnectedRadioHeartbeats, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Give Socket.IO time to initialize, then seed last_seen without waiting
  // for the first full interval.
  setTimeout(persistConnectedRadioHeartbeats, 5000).unref?.();
}
