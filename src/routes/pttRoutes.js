import { Router } from 'express';
import { signalingService } from '../services/signalingService.js';

const router = Router();

function validatePttRequest(req, res) {
  const { channelId, unitId } = req.body;

  if (!channelId || !unitId) {
    res.status(400).json({ error: 'channelId and unitId required' });
    return null;
  }

  const presence = signalingService.unitPresence?.get(unitId);
  if (!presence) {
    console.warn(`[PTT-HTTP] Rejected: unknown unitId "${unitId}"`);
    res.status(403).json({ error: 'Unit not authenticated with signaling' });
    return null;
  }

  return { channelId, unitId };
}

router.post('/start', (req, res) => {
  const validated = validatePttRequest(req, res);
  if (!validated) return;
  const { channelId, unitId } = validated;

  try {
    const io = signalingService.io;
    if (!io) {
      console.warn('[PTT-HTTP] Socket.IO not initialized');
      return res.status(503).json({ error: 'Signaling not ready' });
    }

    const transmissionData = {
      unitId,
      channelId,
      timestamp: Date.now(),
      isEmergency: signalingService.emergencyStates?.has(channelId) || false,
      source: 'native-service',
    };

    signalingService.activeTransmissions.set(channelId, transmissionData);

    const presence = signalingService.unitPresence.get(unitId);
    if (presence) {
      presence.status = 'transmitting';
    }

    io.to(`channel:${channelId}`).emit('ptt:start', transmissionData);

    if (signalingService._emitCallback) {
      signalingService._emitCallback('pttStart', transmissionData);
    }

    console.log(`[PTT-HTTP] PTT START: ${unitId} on ${channelId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PTT-HTTP] Error on ptt/start:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/end', (req, res) => {
  const validated = validatePttRequest(req, res);
  if (!validated) return;
  const { channelId, unitId } = validated;

  try {
    const io = signalingService.io;
    if (!io) {
      console.warn('[PTT-HTTP] Socket.IO not initialized');
      return res.status(503).json({ error: 'Signaling not ready' });
    }

    const transmission = signalingService.activeTransmissions.get(channelId);
    const duration = transmission ? Date.now() - transmission.timestamp : 0;

    const endData = {
      unitId,
      channelId,
      timestamp: Date.now(),
      duration,
      gracePeriodMs: signalingService.GRACE_PERIOD_MS || 3000,
      source: 'native-service',
    };

    signalingService.activeTransmissions.delete(channelId);

    if (signalingService.graceChannels) {
      signalingService.graceChannels.set(channelId, {
        unitId,
        expiresAt: Date.now() + (signalingService.GRACE_PERIOD_MS || 3000),
      });

      setTimeout(() => {
        const grace = signalingService.graceChannels.get(channelId);
        if (grace && grace.unitId === unitId) {
          signalingService.graceChannels.delete(channelId);
        }
      }, signalingService.GRACE_PERIOD_MS || 3000);
    }

    const presence = signalingService.unitPresence.get(unitId);
    if (presence) {
      presence.status = 'online';
    }

    io.to(`channel:${channelId}`).emit('ptt:end', endData);

    if (signalingService._emitCallback) {
      signalingService._emitCallback('pttEnd', endData);
    }

    console.log(`[PTT-HTTP] PTT END: ${unitId} on ${channelId} (${duration}ms)`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PTT-HTTP] Error on ptt/end:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
