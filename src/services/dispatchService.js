import pool, * as db from '../db/index.js';
import { ensurePagingRosterSchema } from './pagingRosterService.js';

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
      CASE
        WHEN r.last_seen > NOW() - INTERVAL '90 seconds' THEN p.channel
        ELSE NULL
      END AS channel,
      CASE
        WHEN r.last_seen > NOW() - INTERVAL '90 seconds' THEN
          CASE
            WHEN COALESCE(p.is_emergency, false) THEN 'emergency'
            WHEN p.status = 'transmitting' THEN 'transmitting'
            ELSE 'online'
          END
        ELSE 'offline'
      END AS status,
      r.last_seen AS last_seen,
      CASE
        WHEN r.last_seen > NOW() - INTERVAL '90 seconds' THEN COALESCE(p.is_emergency, false)
        ELSE false
      END AS is_emergency
    FROM radios r
    LEFT JOIN users u ON u.id = r.assigned_unit_id
    LEFT JOIN units p ON p.unit_identity = COALESCE(NULLIF(u.unit_id, ''), u.username, r.radio_id)
    WHERE r.is_active = true
    ORDER BY
      CASE WHEN r.last_seen > NOW() - INTERVAL '90 seconds' THEN 0 ELSE 1 END,
      COALESCE(NULLIF(u.unit_id, ''), u.username, r.radio_id),
      r.radio_id
  `);

  return result.rows;
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
