import * as db from '../db/index.js';

export async function validateLogin(username, password) {
  const user = await db.getUser(username);
  if (!user) {
    return { success: false, error: 'Invalid username or password' };
  }
  
  if (user.status === 'blocked') {
    return { success: false, error: 'Account is blocked' };
  }
  
  const valid = await db.verifyPassword(user, password);
  if (!valid) {
    return { success: false, error: 'Invalid username or password' };
  }
  
  await db.updateLastLogin(user.id);
  
  return { 
    success: true, 
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      unit_id: user.unit_id,
      is_dispatcher: user.is_dispatcher
    }
  };
}

export async function logUserActivity(userId, username, action, details, channel = null) {
  await db.logActivity(userId, username, action, details, channel);
}
