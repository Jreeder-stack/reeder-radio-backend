import { spawn } from 'child_process';
import * as adminService from '../services/adminService.js';
import * as authService from '../services/authService.js';
import { success, error, created } from '../utils/response.js';
import { startDispatcher, stopDispatcher } from '../services/aiDispatchService.js';
import { getAiDispatchChannel, setAiDispatchChannel, getAllChannels } from '../db/index.js';
import { signalingService } from '../services/signalingService.js';

const DSP_DEFAULTS = {
  txHpAlpha: 0.9889,
  txLpB0: 0.1554851459,
  txLpB1: 0.3109702918,
  txLpB2: 0.1554851459,
  txLpA1: -0.5765879199,
  txLpA2: 0.1985285035,
  txCompThresholdDb: -18.0,
  txCompRatio: 3.0,
  txCompAttackMs: 0.003,
  txCompReleaseMs: 0.15,
  txGain: 1.4,
  rxHpAlpha: 0.9673,
  rxLpB0: 0.06050,
  rxLpB1: 0.12100,
  rxLpB2: 0.06050,
  rxLpA1: -1.19388,
  rxLpA2: 0.43585,
  rxGateThresholdDb: -40.0,
  rxGain: 2.5,
  opusBitrate: 48000,
};

let currentDspConfig = { ...DSP_DEFAULTS };

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
    const { name, zone, zone_id, zoneId } = req.body;
    const resolvedZoneId = zone_id || zoneId || null;
    if (!name || !zone) {
      return error(res, 'Name and zone required', 400);
    }
    const channel = await adminService.createChannel(name, zone, resolvedZoneId);
    created(res, { channel });
  } catch (err) {
    if (err.code === '23505') {
      return error(res, 'Channel name already exists in this zone', 400);
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

export function getAudioTuning(req, res) {
  try {
    success(res, { config: currentDspConfig, defaults: DSP_DEFAULTS });
  } catch (err) {
    console.error('Get audio tuning error:', err);
    error(res, 'Failed to get audio tuning', 500);
  }
}

export function setAudioTuning(req, res) {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return error(res, 'Invalid config object', 400);
    }
    for (const [key, value] of Object.entries(updates)) {
      if (key in DSP_DEFAULTS && typeof value === 'number' && isFinite(value)) {
        currentDspConfig[key] = value;
      }
    }
    if (signalingService.io) {
      signalingService.io.emit('radio:dsp_config', currentDspConfig);
      console.log('[AudioTuning] DSP config broadcast to all connected clients');
    }
    success(res, { config: currentDspConfig });
  } catch (err) {
    console.error('Set audio tuning error:', err);
    error(res, 'Failed to set audio tuning', 500);
  }
}

export function resetAudioTuning(req, res) {
  try {
    currentDspConfig = { ...DSP_DEFAULTS };
    if (signalingService.io) {
      signalingService.io.emit('radio:dsp_config', currentDspConfig);
      console.log('[AudioTuning] DSP config reset to defaults and broadcast');
    }
    success(res, { config: currentDspConfig });
  } catch (err) {
    console.error('Reset audio tuning error:', err);
    error(res, 'Failed to reset audio tuning', 500);
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
      const allChannels = await getAllChannels();
      const channelData = allChannels.find(ch => ch.room_key === targetChannel || ch.name === targetChannel);
      const roomKey = channelData?.room_key || targetChannel;
      await setAiDispatchChannel(roomKey);
      await adminService.setAiDispatchEnabled(true);
      startDispatcher(channelData?.name || targetChannel, roomKey).catch(err => {
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

export function streamVmLogs(req, res) {
  const source = req.query.source === 'system' ? 'system' : 'server';
  let closed = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let child;
  if (source === 'system') {
    child = spawn('journalctl', ['-f', '-n', '50', '--no-pager'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    child = spawn('pm2', ['logs', '--raw', '--lines', '50'], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  const safeSend = (data) => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  };

  const sendLine = (line) => {
    const text = line.toString();
    if (text.trim()) {
      safeSend({ line: text, source, ts: Date.now() });
    }
  };

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    lines.forEach(sendLine);
  });

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    lines.forEach(sendLine);
  });

  child.on('error', (err) => {
    safeSend({ line: `[error] Failed to start ${source} log stream: ${err.message}`, source, ts: Date.now() });
  });

  child.on('close', (code) => {
    if (stdoutBuf.trim()) sendLine(stdoutBuf);
    if (stderrBuf.trim()) sendLine(stderrBuf);
    stdoutBuf = '';
    stderrBuf = '';
    safeSend({ line: `[info] ${source} log stream ended (exit code ${code})`, source, ts: Date.now() });
    if (!closed && !res.writableEnded) {
      try { res.end(); } catch (_) {}
    }
  });

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) return;
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 20000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { child.kill('SIGTERM'); } catch (_) {}
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}
