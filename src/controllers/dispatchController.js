import * as dispatchService from '../services/dispatchService.js';
import { success, error, created } from '../utils/response.js';
import { getDispatcher, startDispatcher } from '../services/aiDispatchService.js';
import { isAiDispatchEnabled, getAiDispatchChannel } from '../db/index.js';

export async function getUnits(req, res) {
  try {
    const units = await dispatchService.getAllUnits();
    success(res, { units });
  } catch (err) {
    console.error('Get units error:', err);
    error(res, 'Failed to get units', 500);
  }
}

export async function updateUnit(req, res) {
  try {
    const { identity, channel, status, location, isEmergency } = req.body;
    const unit = await dispatchService.upsertUnit(identity, channel, status, location, isEmergency);
    success(res, { unit });
  } catch (err) {
    console.error('Update unit error:', err);
    error(res, 'Failed to update unit', 500);
  }
}

export async function toggleEmergency(req, res) {
  try {
    const { id } = req.params;
    const { active } = req.body;
    const unit = await dispatchService.setUnitEmergency(id, active);
    if (!unit) {
      return error(res, 'Unit not found', 404);
    }
    success(res, { unit });
  } catch (err) {
    console.error('Emergency toggle error:', err);
    error(res, 'Failed to toggle emergency status', 500);
  }
}

export async function acknowledgeEmergency(req, res) {
  try {
    const { identity, channel, acknowledgedBy } = req.body;
    await dispatchService.acknowledgeEmergency(identity, channel, acknowledgedBy);
    success(res, { success: true });
  } catch (err) {
    console.error('Acknowledge emergency error:', err);
    error(res, 'Failed to acknowledge emergency', 500);
  }
}

export async function getMonitorSet(req, res) {
  try {
    const data = await dispatchService.getMonitorSet(req.params.dispatcherId);
    success(res, { monitor: data });
  } catch (err) {
    console.error('Get monitor set error:', err);
    error(res, 'Failed to get monitor set', 500);
  }
}

export async function setMonitorSet(req, res) {
  try {
    const { primary, monitored, primaryTxChannelId } = req.body;
    const result = await dispatchService.setMonitorSet(
      req.params.dispatcherId, primary, monitored, primaryTxChannelId
    );
    success(res, { monitor: result });
  } catch (err) {
    console.error('Set monitor set error:', err);
    error(res, 'Failed to set monitor set', 500);
  }
}

export async function getChannels(req, res) {
  try {
    const channels = await dispatchService.getRadioChannels();
    success(res, { channels });
  } catch (err) {
    console.error('Get radio channels error:', err);
    error(res, 'Failed to get radio channels', 500);
  }
}

export async function createChannel(req, res) {
  try {
    const { name, livekit_room_name, is_emergency_only, is_active } = req.body;
    if (!name) {
      return error(res, 'Channel name required', 400);
    }
    const channel = await dispatchService.createRadioChannel(
      name, livekit_room_name, is_emergency_only, is_active
    );
    created(res, { channel });
  } catch (err) {
    console.error('Create radio channel error:', err);
    error(res, 'Failed to create radio channel', 500);
  }
}

export async function updateChannel(req, res) {
  try {
    const { id } = req.params;
    const channel = await dispatchService.updateRadioChannel(id, req.body);
    if (!channel) {
      return error(res, 'Channel not found', 404);
    }
    success(res, { channel });
  } catch (err) {
    console.error('Update radio channel error:', err);
    error(res, 'Failed to update radio channel', 500);
  }
}

export async function getPatches(req, res) {
  try {
    const patches = await dispatchService.getChannelPatches();
    success(res, { patches });
  } catch (err) {
    console.error('Get channel patches error:', err);
    error(res, 'Failed to get channel patches', 500);
  }
}

export async function createPatch(req, res) {
  try {
    const { name, source_channel_id, target_channel_id, is_enabled } = req.body;
    if (!source_channel_id || !target_channel_id) {
      return error(res, 'Source and target channel IDs required', 400);
    }
    const patch = await dispatchService.createChannelPatch(
      name, source_channel_id, target_channel_id, is_enabled
    );
    created(res, { patch });
  } catch (err) {
    console.error('Create channel patch error:', err);
    error(res, 'Failed to create channel patch', 500);
  }
}

export async function updatePatch(req, res) {
  try {
    const { id } = req.params;
    const patch = await dispatchService.updateChannelPatch(id, req.body);
    if (!patch) {
      return error(res, 'Patch not found', 404);
    }
    success(res, { patch });
  } catch (err) {
    console.error('Update channel patch error:', err);
    error(res, 'Failed to update channel patch', 500);
  }
}

export async function getEvents(req, res) {
  try {
    const events = await dispatchService.getRadioEvents(100);
    success(res, { events });
  } catch (err) {
    console.error('Get radio events error:', err);
    error(res, 'Failed to get radio events', 500);
  }
}

export async function notifyJoin(req, res) {
  try {
    const { channel, identity } = req.body;
    
    if (!channel || !identity) {
      return error(res, 'Channel and identity required', 400);
    }
    
    const enabled = await isAiDispatchEnabled();
    if (!enabled) {
      return success(res, { 
        triggered: false, 
        reason: 'AI Dispatch is disabled' 
      });
    }
    
    const configuredChannel = await getAiDispatchChannel();
    
    if (configuredChannel !== channel) {
      return success(res, { 
        triggered: false, 
        reason: `Channel ${channel} is not the configured dispatch channel (${configuredChannel})` 
      });
    }
    
    console.log(`[AI-Dispatcher] Notify join received: ${identity} on ${channel}`);
    
    const dispatcher = getDispatcher();
    
    if (dispatcher && dispatcher.room) {
      return success(res, { 
        triggered: false, 
        reason: 'AI Dispatcher is already connected',
        channel 
      });
    }
    
    if (dispatcher && dispatcher.isRunning) {
      await dispatcher.rejoinIfNeeded();
      return success(res, { 
        triggered: true, 
        channel,
        message: 'AI Dispatcher rejoin triggered' 
      });
    }
    
    await startDispatcher(channel);
    success(res, { 
      triggered: true, 
      channel,
      message: 'AI Dispatcher started' 
    });
  } catch (err) {
    console.error('Notify join error:', err);
    error(res, 'Failed to process notify join', 500);
  }
}

export async function notifyEmergency(req, res) {
  try {
    const { channel, identity, active } = req.body;
    
    if (!channel || !identity) {
      return error(res, 'Channel and identity required', 400);
    }
    
    console.log(`[AI-Dispatcher] Emergency notification: ${identity} on ${channel}, active: ${active}`);
    
    const enabled = await isAiDispatchEnabled();
    if (!enabled) {
      return success(res, { 
        triggered: false, 
        reason: 'AI Dispatch is disabled' 
      });
    }
    
    const dispatcher = getDispatcher();
    
    if (!dispatcher || !dispatcher.room) {
      console.log('[AI-Dispatcher] Dispatcher not connected, starting...');
      await startDispatcher(channel);
    }
    
    const activeDispatcher = getDispatcher();
    
    if (activeDispatcher && activeDispatcher.aiService && active) {
      activeDispatcher.aiService.handleEmergencySignal(identity, channel);
      return success(res, { 
        triggered: true, 
        channel,
        message: 'Emergency escalation started' 
      });
    }
    
    success(res, { 
      triggered: false, 
      reason: 'AI Dispatcher not available or emergency cancelled',
      channel 
    });
  } catch (err) {
    console.error('Notify emergency error:', err);
    error(res, 'Failed to process emergency notification', 500);
  }
}
