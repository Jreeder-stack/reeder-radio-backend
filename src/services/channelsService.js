import * as db from '../db/index.js';

export async function getAccessibleChannels(userId) {
  const allChannels = await db.getAllChannels();
  const userAccess = await db.getUserChannelAccess(userId);
  
  if (userAccess.length === 0) {
    return allChannels.filter(ch => ch.enabled);
  }
  
  return allChannels.filter(ch => ch.enabled && userAccess.includes(ch.id));
}

export async function getAllChannels() {
  return db.getAllChannels();
}
