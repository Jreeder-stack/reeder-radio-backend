import pool, * as db from '../db/index.js';
import { ensurePagingRosterSchema } from './pagingRosterService.js';
import { signalingService } from './signalingService.js';
import { startRadioHeartbeatService } from './radioHeartbeatService.js';

startRadioHeartbeatService();

export async function getAllUnits() {
  await ensurePagingRosterSchema();

  const result = await pool.query(`
    SELECT
      r.id,
      r.id AS radio_pk,
      r.radio_id,
      r.is_active,
      r.is_locked,
      r.assigned_unit_id,
      COALESCE(NULLIF(u.unit_id, ''), u.username, r.radio_id) AS unit_identity,
      u.username,
      p.channel AS last_known_channel,
      p.status AS last_known_status,
      COALESCE(r.last_seen, p.last_seen) AS last_seen,
      COALESCE(p.is_emergency, false) AS last_known_emergency
    FROM radios r
    LEFT JOIN users u ON u.id = r.assigned_unit_id
    LEFT JOIN units p ON p.unit_identity = COALESCE(NULLIF(u.unit_id, ''), u.username, r.radio_id)
    WHERE r.is_active = true
    ORDER BY
      COALESCE(NULLIF(u.unit_id, ''), u.username, r.radio_id),
      r.radio_id
  `);

  const liveRadios = new Map();
  const sockets = signalingService.io?.sockets?.sockets;
  if (sockets) {
    for (const [, socket] of sockets) {
      if (!socket.connected || !socket.isRadioDevice || !socket.radioId) continue;

      const channels = socket.channels ? Array.from(socket.channels) : [];
      const channel = channels[0] || null;
      let status = 'online';
      let isEmergency = false;

      if (channel) {
        const transmission = signalingService.activeTransmissions?.get(channel);
        if (transmission?.deviceId === socket.deviceId || transmission?.floorKey === socket.floorKey) {
          status = 'transmitting';
        }

        const emergency = signalingService.emergencyStates?.get(channel);
        if (emergency?.unitId === socket.unitId) {
          status = 'emergency';
          isEmergency = true;
        }
      }

      liveRadios.set(String(socket.radioId), {
        channel,
        status,
        isEmergency,
      });
    }
  }

  const now = Date.now();
  const heartbeatGraceMs = 110000;

  return result.rows
    .map((row) => {
      const live = liveRadios.get(String(row.radio_id));
      const lastSeenMs = row.last_seen ? new Date(row.last_seen).getTime() : 0;
      const heartbeatFresh = lastSeenMs > 0 && (now - lastSeenMs) <= heartbeatGraceMs;
      const online = Boolean(live) || heartbeatFresh;

      let status = 'offline';
      let channel = null;
      let isEmergency = false;

      if (live) {
        status = live.status;
        channel = live.channel;
        isEmergency = live.isEmergency;
      } else if (heartbeatFresh) {
        // The radio may be connected to another backend instance. Keep it
        // online during the persisted heartbeat grace window, but do not copy
        // shared callsign transmit/emergency state to every physical radio.
        status = 'online';
        channel = row.last_known_channel || null;
      }

      return {
        id: row.id,
        radio_pk: row.radio_pk,
        radio_id: row.radio_id,
        is_active: row.is_active,
        is_locked: row.is_locked,
        assigned_unit_id: row.assigned_unit_id,
        unit_identity: row.unit_identity,
        username: row.username,
        channel,
        status,
        last_seen: row.last_seen,
        is_emergency: isEmergency,
      };
    })
    .sort((a, b) => {
      const onlineOrder = (a.status === 'offline' ? 1 : 0) - (b.status === 'offline' ? 1 : 0);
      if (onlineOrder !== 0) return onlineOrder;
      const identityOrder = String(a.unit_identity).localeCompare(String(b.unit_identity));
      if (identityOrder !== 0) return identityOrder;
      return String(a.radio_id).localeCompare(String(b.radio_id));
    });
}

export async function upsertUnit(identity, channel, status, location, isEmergency) {
  const unit = await db.upsertUnitPresence(identity, channel, status, location, isEmergency);
  await db.logRadioEvent(identity, channel, 'status_update', { status });
  return unit;
}

export async function setUnitEmergency(unitId, active) {
  const unit = await db.setUnitEmergency(unitId, active);
  if (unit) {
    await db.logRadioEvent(
      unit.unit_identity,
      unit.channel,
      active ? 'emergency_activated' : 'emergency_cleared',
      { active }
    );
  }
  return unit;
}

export async function acknowledgeEmergency(identity, channel, acknowledgedBy) {
  await db.logRadioEvent(identity, channel, 'emergency_ack', { acknowledgedBy });
}

export async function resetEmergency(identity, channel, resetBy) {
  await db.logRadioEvent(identity, channel, 'emergency_reset', { resetBy });
}

export async function getMonitorSet(dispatcherId) {
  return db.getMonitorSet(dispatcherId);
}

export async function setMonitorSet(dispatcherId, primary, monitored, primaryTxChannelId) {
  return db.setMonitorSet(dispatcherId, primary, monitored, primaryTxChannelId);
}

export async function getRadioChannels() {
  return db.getAllChannels();
}

export async function createRadioChannel(name, livekitRoomName, isEmergencyOnly, isActive) {
  return db.createRadioChannel(name, livekitRoomName || name, isEmergencyOnly, isActive);
}

export async function updateRadioChannel(id, updates) {
  return db.updateRadioChannel(id, updates);
}

export async function getChannelPatches() {
  return db.getAllChannelPatches();
}

export async function createChannelPatch(name, sourceChannelId, targetChannelId, isEnabled) {
  return db.createChannelPatch(name, sourceChannelId, targetChannelId, isEnabled);
}

export async function updateChannelPatch(id, updates) {
  return db.updateChannelPatch(id, updates);
}

export async function getRadioEvents(limit = 100) {
  return db.getRadioEvents(limit);
}
