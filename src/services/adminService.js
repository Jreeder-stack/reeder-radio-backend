import * as db from '../db/index.js';

export async function getAllUsers() {
  return db.getAllUsers();
}

export async function updateUser(id, updates) {
  return db.updateUser(id, updates);
}

export async function deleteUser(id) {
  return db.deleteUser(id);
}

export async function updateUserPassword(id, newPassword) {
  return db.updateUserPassword(id, newPassword);
}

export async function createUserWithChannels(username, password, role, email, unit_id, channelIds, is_dispatcher) {
  return db.createUserWithChannels(username, password, role, email, unit_id, channelIds, is_dispatcher);
}

export async function getUserChannelAccess(userId) {
  return db.getUserChannelAccess(userId);
}

export async function setUserChannelAccess(userId, channelIds) {
  return db.setUserChannelAccess(userId, channelIds);
}

export async function getAllZones() {
  return db.getAllZones();
}

export async function createZone(name) {
  return db.createZone(name);
}

export async function updateZone(id, name) {
  return db.updateZone(id, name);
}

export async function deleteZone(id) {
  return db.deleteZone(id);
}

export async function getAllChannels() {
  return db.getAllChannels();
}

export async function updateChannel(id, updates) {
  return db.updateChannel(id, updates);
}

export async function createChannel(name, zoneName, zoneId) {
  return db.createChannel(name, zoneName, zoneId);
}

export async function deleteChannel(id) {
  return db.deleteChannel(id);
}

export async function getActivityLogs(limit = 100) {
  return db.getActivityLogs(limit);
}
