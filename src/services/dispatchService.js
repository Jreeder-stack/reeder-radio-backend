import * as db from '../db/index.js';

export async function getAllUnits() {
  return db.getAllUnitPresence();
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
