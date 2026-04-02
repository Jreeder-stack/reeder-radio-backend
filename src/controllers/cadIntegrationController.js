import * as db from '../db/index.js';
import * as authService from '../services/authService.js';
import { success, error } from '../utils/response.js';

export async function cadLogin(req, res) {
  try {
    const { username } = req.body;

    if (!username) {
      return error(res, 'Username is required', 400);
    }

    const user = await db.getUser(username);

    if (!user) {
      console.log(`[CAD-LOGIN] User not found: "${username}"`);
      return error(res, 'User not found', 404);
    }

    if (user.status === 'blocked') {
      console.log(`[CAD-LOGIN] User blocked: "${username}"`);
      return error(res, 'Account is blocked', 403);
    }

    await db.updateLastLogin(user.id);

    const userData = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      unit_id: user.unit_id,
      is_dispatcher: user.is_dispatcher,
    };

    req.session.user = userData;

    req.session.save((saveErr) => {
      if (saveErr) {
        console.error(`[CAD-LOGIN] Session save error for "${username}":`, saveErr);
        return error(res, 'Session creation failed', 500);
      }

      console.log(`[CAD-LOGIN] Success: username="${username}" id=${userData.id} role=${userData.role} unit_id=${userData.unit_id} is_dispatcher=${userData.is_dispatcher} sessionID=${req.sessionID?.substring(0, 8)}...`);

      authService.logUserActivity(userData.id, userData.username, 'cad-login', {});

      success(res, { user: userData });
    });
  } catch (err) {
    console.error('[CAD-LOGIN] Error:', err);
    error(res, 'CAD login failed', 500);
  }
}

export async function verifyUser(req, res) {
  try {
    const { username } = req.body;

    if (!username) {
      return error(res, 'Username is required', 400);
    }

    const user = await db.getUser(username);

    if (!user) {
      return success(res, {
        exists: false,
        username,
      });
    }

    console.log(`[CAD-VERIFY] User verified: "${username}" unit_id=${user.unit_id} role=${user.role}`);

    success(res, {
      exists: true,
      username: user.username,
      unit_id: user.unit_id,
      role: user.role,
      is_dispatcher: user.is_dispatcher || false,
    });
  } catch (err) {
    console.error('[CAD-VERIFY] Error:', err);
    error(res, 'User verification failed', 500);
  }
}

export async function getZones(req, res) {
  try {
    const zones = await db.getAllZones();
    const allChannels = await db.getAllChannels();

    const zonesWithChannels = zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      channels: allChannels
        .filter((ch) => ch.zone === zone.name)
        .map((ch) => ({
          id: ch.id,
          name: ch.name,
          zone: ch.zone,
          enabled: ch.enabled,
          room_key: ch.room_key || `${ch.zone || 'Default'}__${ch.name}`,
        })),
    }));

    console.log(`[CAD-ZONES] Returning ${zonesWithChannels.length} zones`);
    success(res, { zones: zonesWithChannels });
  } catch (err) {
    console.error('[CAD-ZONES] Error:', err);
    error(res, 'Failed to get zones', 500);
  }
}

export async function getChannels(req, res) {
  try {
    const { zone } = req.query;
    const allChannels = await db.getAllChannels();

    let channels = allChannels.filter((ch) => ch.enabled);

    if (zone) {
      channels = channels.filter((ch) => ch.zone === zone);
    }

    const result = channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      zone: ch.zone,
      room_key: ch.room_key || `${ch.zone || 'Default'}__${ch.name}`,
    }));

    console.log(`[CAD-CHANNELS] Returning ${result.length} channels${zone ? ` (zone=${zone})` : ''}`);
    success(res, { channels: result });
  } catch (err) {
    console.error('[CAD-CHANNELS] Error:', err);
    error(res, 'Failed to get channels', 500);
  }
}
