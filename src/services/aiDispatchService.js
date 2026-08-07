let activeDispatcher = null;

export function setActiveDispatcherCompatibility(dispatcher) {
  activeDispatcher = dispatcher || null;
}

function compatibilityView(dispatcher) {
  if (!dispatcher) return null;
  return {
    get isRunning() { return dispatcher.isRunning === true; },
    get connected() { return dispatcher.connected === true; },
    get channelName() { return dispatcher.context?.roomKey || dispatcher.configuredChannel || null; },
    get configuredChannel() { return dispatcher.context?.roomKey || dispatcher.configuredChannel || null; },
    get displayChannel() { return dispatcher.context?.channelName || dispatcher.displayChannel || null; },
    get room() { return dispatcher.connected ? { name: dispatcher.context?.roomKey || null } : null; },
    get profileId() { return dispatcher.context?.profileId || null; },
    get aiService() {
      return {
        handleEmergencySignal: async (unitId, channelId) => dispatcher.handleEmergencyStart(channelId, unitId),
      };
    },
    async rejoinIfNeeded() {
      if (dispatcher.isRunning && dispatcher.connected) return true;
      return dispatcher.start();
    },
    async publishAudio(_audioBuffer, spokenText = '') {
      if (!spokenText) return false;
      return dispatcher._speak(spokenText, null);
    },
    async handlePttStart(channelId, unitId, isEmergency = false) {
      return dispatcher.handlePttStart(channelId, unitId, isEmergency);
    },
    async handlePttEnd(channelId, unitId, gracePeriodMs = null) {
      return dispatcher.handlePttEnd(channelId, unitId, gracePeriodMs);
    },
    async handleEmergencyStart(channelId, unitId) {
      return dispatcher.handleEmergencyStart(channelId, unitId);
    },
    async handleEmergencyEnd(channelId, unitId) {
      return dispatcher.handleEmergencyEnd(channelId, unitId);
    },
    matchesChannel(channelId) {
      return dispatcher.matchesChannel(channelId);
    },
    getPipelineStatus() {
      return dispatcher.getPipelineStatus();
    },
  };
}

export function getDispatcher() {
  return compatibilityView(activeDispatcher);
}

export async function startDispatcher(channelName = null, roomKey = null) {
  const { aiDispatcherRuntimeManager } = await import('./aiDispatcherRuntimeManager.js');
  const profiles = await aiDispatcherRuntimeManager.listProfilesWithStatus();
  const requested = String(roomKey || channelName || '').trim();
  const profile = profiles.find((item) => requested && (
    String(item.roomKey || '') === requested
    || String(item.channelName || '') === requested
    || String(item.channelId || '') === requested
  )) || profiles.find((item) => item.enabled) || profiles[0];

  if (!profile) throw new Error('Create an AI dispatcher profile before starting V3');
  const runtime = await aiDispatcherRuntimeManager.startProfile(profile.id);
  setActiveDispatcherCompatibility(runtime.dispatcher);
  return compatibilityView(runtime.dispatcher);
}

export async function stopDispatcher() {
  const dispatcher = activeDispatcher;
  if (!dispatcher) return true;
  const profileId = dispatcher.context?.profileId || dispatcher.context?.runtimeId;
  if (!profileId) {
    await dispatcher.stop();
    setActiveDispatcherCompatibility(null);
    return true;
  }
  const { aiDispatcherRuntimeManager } = await import('./aiDispatcherRuntimeManager.js');
  await aiDispatcherRuntimeManager.stopProfile(profileId);
  return true;
}

export async function restartDispatcher(channelName = null, roomKey = null) {
  await stopDispatcher();
  return startDispatcher(channelName, roomKey);
}

export async function broadcastMessage(channelName, message) {
  try {
    const { signalingService } = await import('./signalingService.js');
    signalingService.broadcastDataToChannel(channelName, {
      type: 'new_message',
      message,
    });
    return true;
  } catch (error) {
    console.error(`[broadcastMessage] Failed to broadcast to ${channelName}:`, error.message);
    return false;
  }
}

// Explicit migration guard for any stale import. The legacy dispatcher class
// no longer exists and cannot be started.
export class AIDispatcher {
  constructor() {
    throw new Error('Legacy AIDispatcher has been removed. Use AI Dispatcher V3.');
  }
}
