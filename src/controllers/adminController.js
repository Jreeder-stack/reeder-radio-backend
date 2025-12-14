import * as adminService from '../services/adminService.js';
import * as authService from '../services/authService.js';
import { success, error, created } from '../utils/response.js';
import { startDispatcher, stopDispatcher } from '../services/aiDispatchService.js';
import { getAiDispatchChannel, setAiDispatchChannel } from '../db/index.js';

export async function listUsers(req, res) {
  try {
    const users = await adminService.getAllUsers();
    success(res, { users });
  } catch (err) {
    console.error('List users error:', err);
    error(res, 'Failed to list users', 500);
  }
}

export async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const user = await adminService.updateUser(id, req.body);
    if (!user) {
      return error(res, 'User not found', 404);
    }
    await authService.logUserActivity(req.session.user.id, req.session.user.username, 'admin_update_user', { targetUserId: id, updates: req.body });
    success(res, { user });
  } catch (err) {
    console.error('Update user error:', err);
    error(res, 'Failed to update user', 500);
  }
}

export async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    const user = await adminService.deleteUser(id);
    if (!user) {
      return error(res, 'User not found', 404);
    }
    await authService.logUserActivity(req.session.user.id, req.session.user.username, 'admin_delete_user', { deletedUser: user.username });
    success(res, { success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    error(res, 'Failed to delete user', 500);
  }
}

export async function createUser(req, res) {
  try {
    const { username, password, role, email, unit_id, channelIds, is_dispatcher } = req.body;
    if (!username || !password) {
      return error(res, 'Username and password required', 400);
    }
    const user = await adminService.createUserWithChannels(
      username, password, role || 'user', email || null, unit_id || null, channelIds || [], is_dispatcher || false
    );
    await authService.logUserActivity(req.session.user.id, req.session.user.username, 'admin_create_user', { newUser: username });
    created(res, { user });
  } catch (err) {
    if (err.code === '23505') {
      return error(res, 'Username already exists', 400);
    }
    console.error('Create user error:', err);
    error(res, 'Failed to create user', 500);
  }
}

export async function updateUserPassword(req, res) {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password) {
      return error(res, 'Password required', 400);
    }
    const user = await adminService.updateUserPassword(id, password);
    if (!user) {
      return error(res, 'User not found', 404);
    }
    await authService.logUserActivity(req.session.user.id, req.session.user.username, 'admin_reset_password', { targetUserId: id });
    success(res, { success: true });
  } catch (err) {
    console.error('Update password error:', err);
    error(res, 'Failed to update password', 500);
  }
}

export async function getUserChannels(req, res) {
  try {
    const { id } = req.params;
    const channelIds = await adminService.getUserChannelAccess(id);
    success(res, { channelIds });
  } catch (err) {
    console.error('Get user channels error:', err);
    error(res, 'Failed to get user channels', 500);
  }
}

export async function setUserChannels(req, res) {
  try {
    const { id } = req.params;
    const { channelIds } = req.body;
    await adminService.setUserChannelAccess(id, channelIds || []);
    success(res, { success: true });
  } catch (err) {
    console.error('Set user channels error:', err);
    error(res, 'Failed to set user channels', 500);
  }
}

export async function listChannels(req, res) {
  try {
    const channels = await adminService.getAllChannels();
    success(res, { channels });
  } catch (err) {
    console.error('List channels error:', err);
    error(res, 'Failed to list channels', 500);
  }
}

export async function updateChannel(req, res) {
  try {
    const { id } = req.params;
    const channel = await adminService.updateChannel(id, req.body);
    if (!channel) {
      return error(res, 'Channel not found', 404);
    }
    success(res, { channel });
  } catch (err) {
    console.error('Update channel error:', err);
    error(res, 'Failed to update channel', 500);
  }
}

export async function createChannel(req, res) {
  try {
    const { name, zone, zone_id } = req.body;
    if (!name || !zone) {
      return error(res, 'Name and zone required', 400);
    }
    const channel = await adminService.createChannel(name, zone, zone_id);
    created(res, { channel });
  } catch (err) {
    if (err.code === '23505') {
      return error(res, 'Channel name already exists', 400);
    }
    console.error('Create channel error:', err);
    error(res, 'Failed to create channel', 500);
  }
}

export async function deleteChannel(req, res) {
  try {
    const { id } = req.params;
    const channel = await adminService.deleteChannel(id);
    if (!channel) {
      return error(res, 'Channel not found', 404);
    }
    success(res, { success: true });
  } catch (err) {
    console.error('Delete channel error:', err);
    error(res, 'Failed to delete channel', 500);
  }
}

export async function listZones(req, res) {
  try {
    const zones = await adminService.getAllZones();
    success(res, { zones });
  } catch (err) {
    console.error('List zones error:', err);
    error(res, 'Failed to list zones', 500);
  }
}

export async function createZone(req, res) {
  try {
    const { name } = req.body;
    if (!name) {
      return error(res, 'Zone name required', 400);
    }
    const zone = await adminService.createZone(name);
    created(res, { zone });
  } catch (err) {
    if (err.code === '23505') {
      return error(res, 'Zone name already exists', 400);
    }
    console.error('Create zone error:', err);
    error(res, 'Failed to create zone', 500);
  }
}

export async function updateZone(req, res) {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) {
      return error(res, 'Zone name required', 400);
    }
    const zone = await adminService.updateZone(id, name);
    if (!zone) {
      return error(res, 'Zone not found', 404);
    }
    success(res, { zone });
  } catch (err) {
    console.error('Update zone error:', err);
    error(res, 'Failed to update zone', 500);
  }
}

export async function deleteZone(req, res) {
  try {
    const { id } = req.params;
    const zone = await adminService.deleteZone(id);
    if (!zone) {
      return error(res, 'Zone not found', 404);
    }
    success(res, { success: true });
  } catch (err) {
    console.error('Delete zone error:', err);
    error(res, 'Failed to delete zone', 500);
  }
}

export async function listLogs(req, res) {
  try {
    const logs = await adminService.getActivityLogs(100);
    success(res, { logs });
  } catch (err) {
    console.error('List logs error:', err);
    error(res, 'Failed to list logs', 500);
  }
}

export async function getAiDispatch(req, res) {
  try {
    const enabled = await adminService.getAiDispatchEnabled();
    const channel = await getAiDispatchChannel();
    success(res, { enabled, channel });
  } catch (err) {
    console.error('Get AI dispatch error:', err);
    error(res, 'Failed to get AI dispatch status', 500);
  }
}

export async function setAiDispatch(req, res) {
  try {
    const { enabled, channel } = req.body;
    if (typeof enabled !== 'boolean') {
      return error(res, 'enabled must be a boolean', 400);
    }
    
    if (enabled) {
      const targetChannel = channel !== undefined ? channel : await getAiDispatchChannel();
      if (!targetChannel) {
        return error(res, 'Dispatch channel is required to enable AI', 400);
      }
      await setAiDispatchChannel(targetChannel);
      await adminService.setAiDispatchEnabled(true);
      startDispatcher(targetChannel).catch(err => {
        console.error('Failed to start AI dispatcher:', err.message);
      });
    } else {
      await adminService.setAiDispatchEnabled(false);
      await setAiDispatchChannel('');
      stopDispatcher().catch(err => {
        console.error('Failed to stop AI dispatcher:', err.message);
      });
    }

    const dispatchChannel = await getAiDispatchChannel();

    await authService.logUserActivity(
      req.session.user.id,
      req.session.user.username,
      'admin_toggle_ai_dispatch',
      { enabled, channel: dispatchChannel }
    );
    success(res, { enabled, channel: dispatchChannel });
  } catch (err) {
    console.error('Set AI dispatch error:', err);
    error(res, 'Failed to set AI dispatch status', 500);
  }
}
