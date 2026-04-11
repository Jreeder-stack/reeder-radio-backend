import * as db from '../db/index.js';

export async function getAccessibleChannels(userId, userRole) {
  const allChannels = await db.getAllChannels();
  console.log(`[CHANNELS] DB returned ${allChannels.length} total channels`);
  
  const enabledChannels = allChannels.filter(ch => ch.enabled);
  console.log(`[CHANNELS] ${enabledChannels.length} enabled channels (${allChannels.length - enabledChannels.length} disabled)`);
  
  if (enabledChannels.length === 0) {
    console.log(`[CHANNELS] WARNING: Zero enabled channels in database!`);
    if (allChannels.length === 0) {
      console.log(`[CHANNELS] WARNING: Channels table is EMPTY — this is likely why "No channels available" appears`);
    }
  }
  
  if (userRole === 'admin') {
    console.log(`[CHANNELS] Admin user (id=${userId}) gets all ${enabledChannels.length} enabled channels`);
    return enabledChannels;
  }
  
  const userAccess = await db.getUserChannelAccess(userId);
  console.log(`[CHANNELS] User id=${userId} has ${userAccess.length} channel access entries`);
  
  if (userAccess.length === 0) {
    console.log(`[CHANNELS] No channel access entries for user id=${userId}, deny-by-default: returning 0 channels`);
    return [];
  }
  
  const filtered = enabledChannels.filter(ch => userAccess.includes(ch.id));
  console.log(`[CHANNELS] User id=${userId} filtered to ${filtered.length} accessible channels (from ${enabledChannels.length} enabled)`);
  return filtered;
}

export async function getAllChannels() {
  return db.getAllChannels();
}
