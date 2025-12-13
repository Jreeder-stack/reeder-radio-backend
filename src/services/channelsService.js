import * as db from '../db/index.js';

export async function getAccessibleChannels(userId, userRole) {
  const allChannels = await db.getAllChannels();
  const enabledChannels = allChannels.filter(ch => ch.enabled);
  
  // Admins get access to all enabled channels
  if (userRole === 'admin') {
    return enabledChannels;
  }
  
  const userAccess = await db.getUserChannelAccess(userId);
  
  // If user has no specific channel assignments, give them all enabled channels (fallback)
  if (userAccess.length === 0) {
    return enabledChannels;
  }
  
  // Filter to only channels the user has access to
  return enabledChannels.filter(ch => userAccess.includes(ch.id));
}

export async function getAllChannels() {
  return db.getAllChannels();
}
