const API_BASE = '/api/dispatch';
const MESSAGES_API_BASE = '/api/messages';

async function fetchAPI(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  
  return response.json();
}

export async function getUnits() {
  return fetchAPI('/units');
}

export async function updateUnitStatus(identity, channel, status, location, isEmergency) {
  return fetchAPI('/unit/update', {
    method: 'POST',
    body: JSON.stringify({ identity, channel, status, location, isEmergency }),
  });
}

export async function toggleUnitEmergency(unitId, active) {
  return fetchAPI(`/units/${unitId}/emergency`, {
    method: 'POST',
    body: JSON.stringify({ active }),
  });
}

export async function acknowledgeEmergency(identity, channel, acknowledgedBy) {
  return fetchAPI('/emergency/ack', {
    method: 'POST',
    body: JSON.stringify({ identity, channel, acknowledgedBy }),
  });
}

export async function getChannels() {
  return fetchAPI('/channels');
}

export async function createChannel(name, livekitRoomName, isEmergencyOnly, isActive) {
  return fetchAPI('/channels', {
    method: 'POST',
    body: JSON.stringify({
      name,
      livekit_room_name: livekitRoomName,
      is_emergency_only: isEmergencyOnly,
      is_active: isActive,
    }),
  });
}

export async function updateChannel(id, updates) {
  return fetchAPI(`/channels/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function getPatches() {
  return fetchAPI('/patches');
}

export async function createPatch(name, sourceChannelId, targetChannelId, isEnabled) {
  return fetchAPI('/patches', {
    method: 'POST',
    body: JSON.stringify({
      name,
      source_channel_id: sourceChannelId,
      target_channel_id: targetChannelId,
      is_enabled: isEnabled,
    }),
  });
}

export async function updatePatch(id, updates) {
  return fetchAPI(`/patches/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function getMonitorConfig(dispatcherId) {
  return fetchAPI(`/monitor/${dispatcherId}`);
}

export async function saveMonitorConfig(dispatcherId, primary, monitored, primaryTxChannelId) {
  return fetchAPI(`/monitor/${dispatcherId}`, {
    method: 'POST',
    body: JSON.stringify({ primary, monitored, primaryTxChannelId }),
  });
}

export async function notifyChannelJoin(channel, identity) {
  try {
    await fetchAPI('/notify-join', {
      method: 'POST',
      body: JSON.stringify({ channel, identity }),
    });
  } catch (error) {
    console.warn('[API] Failed to notify channel join:', error.message);
  }
}

export async function getChannelMessages(channel, limit = 50, offset = 0) {
  const response = await fetch(`${MESSAGES_API_BASE}/${encodeURIComponent(channel)}?limit=${limit}&offset=${offset}`, {
    credentials: 'include',
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  
  return response.json();
}

export async function sendTextMessage(channel, content) {
  const response = await fetch(`${MESSAGES_API_BASE}/${encodeURIComponent(channel)}/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ content }),
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  
  return response.json();
}

export async function transcribeMessage(messageId) {
  const response = await fetch(`${MESSAGES_API_BASE}/transcribe/${messageId}`, {
    method: 'POST',
    credentials: 'include',
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  
  return response.json();
}
