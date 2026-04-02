/**
 * =============================================================================
 * CAD INTEGRATION API — REFERENCE GUIDE
 * =============================================================================
 *
 * Authentication:
 *   Most endpoints require the `x-radio-api-key` header set to the value of
 *   the `CAD_INTEGRATION_KEY` environment variable. The `/zones` and
 *   `/channels` endpoints also accept a valid session cookie as an
 *   alternative to the API key. CAD consumers should always use the API key.
 *
 * Endpoints:
 *
 *   POST /api/cad-integration/verify-user
 *     Verify whether a username exists and retrieve basic user info.
 *     Body: { "username": "officer1" }
 *     curl -X POST https://<host>/api/cad-integration/verify-user \
 *       -H "x-radio-api-key: <YOUR_KEY>" \
 *       -H "Content-Type: application/json" \
 *       -d '{"username":"officer1"}'
 *
 *   GET /api/cad-integration/zones
 *     Returns all zones with their nested channels.
 *     curl https://<host>/api/cad-integration/zones \
 *       -H "x-radio-api-key: <YOUR_KEY>"
 *
 *   GET /api/cad-integration/channels?zone=<zoneName>
 *     Returns all enabled channels, optionally filtered by zone.
 *     curl https://<host>/api/cad-integration/channels?zone=Patrol \
 *       -H "x-radio-api-key: <YOUR_KEY>"
 *
 *   GET /api/cad-integration/unit/:unitId/zones
 *     Returns only the zones and channels the specified unit has access to.
 *     curl https://<host>/api/cad-integration/unit/U-101/zones \
 *       -H "x-radio-api-key: <YOUR_KEY>"
 *
 *   GET /api/cad-integration/unit/:unitId/channels
 *     Returns channels assigned to the specified unit, grouped by zone.
 *     curl https://<host>/api/cad-integration/unit/U-101/channels \
 *       -H "x-radio-api-key: <YOUR_KEY>"
 *
 *   GET /api/cad-integration/ptt-status
 *     Returns the current PTT floor state across all channels.
 *     curl https://<host>/api/cad-integration/ptt-status \
 *       -H "x-radio-api-key: <YOUR_KEY>"
 *
 *   GET /api/cad-integration/units
 *     Returns all currently online units with presence info.
 *     curl https://<host>/api/cad-integration/units \
 *       -H "x-radio-api-key: <YOUR_KEY>"
 *
 * =============================================================================
 */

import * as db from '../db/index.js';
import * as authService from '../services/authService.js';
import { signalingService } from '../services/signalingService.js';
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

export async function getUnitZones(req, res) {
  try {
    const { unitId } = req.params;

    if (!unitId) {
      return error(res, 'Unit ID is required', 400);
    }

    const user = await db.getUserByUnitId(unitId);

    if (!user) {
      return error(res, 'Unit not found', 404);
    }

    const channelIds = await db.getUserChannelAccess(user.id);
    const allChannels = await db.getAllChannels();
    const zones = await db.getAllZones();

    const accessibleChannels = allChannels.filter((ch) => channelIds.includes(ch.id) && ch.enabled);

    const accessibleZoneNames = new Set(accessibleChannels.map((ch) => ch.zone));

    const zonesWithChannels = zones
      .filter((zone) => accessibleZoneNames.has(zone.name))
      .map((zone) => ({
        id: zone.id,
        name: zone.name,
        channels: accessibleChannels
          .filter((ch) => ch.zone === zone.name)
          .map((ch) => ({
            id: ch.id,
            name: ch.name,
            zone: ch.zone,
            enabled: ch.enabled,
            room_key: ch.room_key || `${ch.zone || 'Default'}__${ch.name}`,
          })),
      }));

    console.log(`[CAD-UNIT-ZONES] Unit ${unitId}: returning ${zonesWithChannels.length} zones`);
    success(res, { unitId, zones: zonesWithChannels });
  } catch (err) {
    console.error('[CAD-UNIT-ZONES] Error:', err);
    error(res, 'Failed to get unit zones', 500);
  }
}

export async function getUnitChannels(req, res) {
  try {
    const { unitId } = req.params;

    if (!unitId) {
      return error(res, 'Unit ID is required', 400);
    }

    const user = await db.getUserByUnitId(unitId);

    if (!user) {
      return error(res, 'Unit not found', 404);
    }

    const channelIds = await db.getUserChannelAccess(user.id);
    const allChannels = await db.getAllChannels();
    const zones = await db.getAllZones();

    const accessibleChannels = allChannels.filter((ch) => channelIds.includes(ch.id) && ch.enabled);

    const accessibleZoneNames = new Set(accessibleChannels.map((ch) => ch.zone));

    const groupedByZone = zones
      .filter((zone) => accessibleZoneNames.has(zone.name))
      .map((zone) => ({
        zoneId: zone.id,
        zoneName: zone.name,
        channels: accessibleChannels
          .filter((ch) => ch.zone === zone.name)
          .map((ch) => ({
            id: ch.id,
            name: ch.name,
            zone: ch.zone,
            enabled: ch.enabled,
            room_key: ch.room_key || `${ch.zone || 'Default'}__${ch.name}`,
          })),
      }));

    console.log(`[CAD-UNIT-CHANNELS] Unit ${unitId}: returning ${accessibleChannels.length} channels`);
    success(res, { unitId, channelsByZone: groupedByZone });
  } catch (err) {
    console.error('[CAD-UNIT-CHANNELS] Error:', err);
    error(res, 'Failed to get unit channels', 500);
  }
}

export async function getPttStatus(req, res) {
  try {
    const transmissions = [];

    for (const [channelId, transmission] of signalingService.activeTransmissions) {
      transmissions.push({
        channelId,
        unitId: transmission.unitId,
        username: transmission.username,
        startTime: transmission.startTime || transmission.timestamp,
        isEmergency: transmission.isEmergency || false,
      });
    }

    console.log(`[CAD-PTT-STATUS] Returning ${transmissions.length} active transmissions`);
    success(res, { activeTransmissions: transmissions });
  } catch (err) {
    console.error('[CAD-PTT-STATUS] Error:', err);
    error(res, 'Failed to get PTT status', 500);
  }
}

export async function getActiveUnits(req, res) {
  try {
    const presenceList = signalingService.getAllPresence();

    const units = presenceList.map((entry) => ({
      unitId: entry.unitId,
      username: entry.username,
      status: entry.status,
      channels: entry.channels || [],
      lastSeen: entry.lastSeen,
      isDispatcher: entry.isDispatcher || false,
    }));

    console.log(`[CAD-UNITS] Returning ${units.length} active units`);
    success(res, { units });
  } catch (err) {
    console.error('[CAD-UNITS] Error:', err);
    error(res, 'Failed to get active units', 500);
  }
}
