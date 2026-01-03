async function cadRequest(endpoint, method = 'GET', body = null) {
  const CAD_URL = process.env.CAD_URL;
  const CAD_API_KEY = process.env.CAD_API_KEY;
  
  if (!CAD_URL || !CAD_API_KEY) {
    console.warn('[CAD] Integration not configured - missing CAD_URL or CAD_API_KEY');
    return { success: false, error: 'CAD integration not configured' };
  }

  const url = `${CAD_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Radio-API-Key': CAD_API_KEY
    }
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    
    if (!response.ok) {
      console.error(`[CAD] API error: ${response.status}`, data);
      return { success: false, error: data.error || `HTTP ${response.status}` };
    }
    
    return data;
  } catch (error) {
    console.error('[CAD] Request failed:', error.message);
    return { success: false, error: error.message };
  }
}

export async function updateUnitStatus(unitId, status, channel = null) {
  console.log(`[CAD] Updating status: ${unitId} -> ${status}`);
  return cadRequest('/api/radio/status', 'POST', {
    unit_id: unitId,
    status: status,
    channel: channel
  });
}

export async function updateUnitZone(unitId, zone) {
  console.log(`[CAD] Updating zone: ${unitId} -> ${zone}`);
  return cadRequest('/api/radio/zone', 'POST', {
    unit_id: unitId,
    zone: zone
  });
}

export async function getStatusCheck() {
  console.log('[CAD] Getting status check');
  return cadRequest('/api/radio/status-check', 'GET');
}

export async function cycleUnitStatus(unitId) {
  console.log(`[CAD] Cycling status for ${unitId}`);
  return cadRequest(`/api/radio/unit/${encodeURIComponent(unitId)}/status/cycle`, 'POST');
}

export async function createCall(type, priority, location, municipality, notes = '') {
  console.log(`[CAD] Creating call: ${type} at ${location}`);
  return cadRequest('/api/radio/call', 'POST', {
    type: type.toUpperCase(),
    priority,
    location: location.toUpperCase(),
    municipality: municipality.toUpperCase(),
    notes
  });
}

export async function getActiveCalls(status = null) {
  const endpoint = status ? `/api/radio/calls?status=${status}` : '/api/radio/calls';
  return cadRequest(endpoint, 'GET');
}

export async function getCallDetails(callId) {
  return cadRequest(`/api/radio/call/${callId}`, 'GET');
}

export async function updateCall(callId, updates) {
  return cadRequest(`/api/radio/call/${callId}`, 'PATCH', updates);
}

export async function assignUnitToCall(unitId, callId) {
  console.log(`[CAD] Assigning ${unitId} to call ${callId}`);
  return cadRequest('/api/radio/assign', 'POST', {
    unit_id: unitId,
    call_id: callId
  });
}

export async function clearUnit(unitId) {
  console.log(`[CAD] Clearing ${unitId} from call`);
  return cadRequest('/api/radio/clear', 'POST', {
    unit_id: unitId
  });
}

export async function disposeCall(callId, disposition) {
  console.log(`[CAD] Disposing call ${callId}: ${disposition}`);
  return cadRequest('/api/radio/dispose', 'POST', {
    call_id: callId,
    disposition
  });
}

export async function addCallNote(callId, note) {
  return cadRequest('/api/radio/note', 'POST', {
    call_id: callId,
    note
  });
}

export async function queryPerson(firstName, lastName, dob = null) {
  const body = {
    first_name: firstName.toUpperCase(),
    last_name: lastName.toUpperCase()
  };
  if (dob) body.dob = dob;
  console.log(`[CAD] Person query request:`, JSON.stringify(body));
  const result = await cadRequest('/api/radio/query/person', 'POST', body);
  console.log(`[CAD] Person query response:`, JSON.stringify(result));
  return result;
}

export async function queryVehicle(plate, state = 'PA') {
  console.log(`[CAD] Vehicle query: ${plate} ${state}`);
  return cadRequest('/api/radio/query/vehicle', 'POST', {
    plate: plate.toUpperCase(),
    state: state.toUpperCase()
  });
}

export async function queryWarrant(firstName, lastName) {
  console.log(`[CAD] Warrant query: ${firstName} ${lastName}`);
  return cadRequest('/api/radio/query/warrant', 'POST', {
    first_name: firstName.toUpperCase(),
    last_name: lastName.toUpperCase()
  });
}

export async function sendBroadcast(message, priority = 'routine') {
  console.log(`[CAD] Broadcast (${priority}): ${message}`);
  return cadRequest('/api/radio/broadcast', 'POST', {
    message,
    priority
  });
}

export async function getPendingChecks() {
  return cadRequest('/api/radio/pending-checks', 'GET');
}

export async function respondToStatusCheck(unitId, status) {
  return cadRequest('/api/radio/respond-check', 'POST', {
    unit_id: unitId,
    status
  });
}

export function isConfigured() {
  return !!(process.env.CAD_URL && process.env.CAD_API_KEY);
}

export async function getAnimalTypes() {
  const result = await cadRequest('/api/radio/animal/types', 'GET');
  if (result.success === false) {
    return { types: ['Dog', 'Cat', 'Horse', 'Bird', 'Livestock', 'Wildlife', 'Other'] };
  }
  return result;
}

export async function searchAnimal(searchParams) {
  console.log('[CAD] Animal search:', searchParams);
  return cadRequest('/api/radio/animal/search', 'POST', {
    tag: searchParams.tag?.toUpperCase() || '',
    owner_last: searchParams.ownerLast?.toUpperCase() || '',
    owner_first: searchParams.ownerFirst?.toUpperCase() || '',
    microchip: searchParams.microchip || '',
    name: searchParams.name?.toUpperCase() || '',
    animal_type: searchParams.animalType || ''
  });
}

export async function createCitation(type, populateFrom, user) {
  console.log(`[CAD] Creating ${type} from ${populateFrom}`);
  return cadRequest('/api/radio/citation/new', 'POST', {
    type,
    populate_from: populateFrom,
    unit_id: user?.unit_id || user?.username
  });
}

export async function getMapUrl() {
  const CAD_URL = process.env.CAD_URL;
  if (!CAD_URL) return null;
  return `${CAD_URL}/map`;
}

export async function createFieldInterview(fiData, user) {
  console.log('[CAD] Creating FI:', fiData);
  return cadRequest('/api/radio/fi/create', 'POST', {
    first_name: fiData.firstName?.toUpperCase() || '',
    last_name: fiData.lastName?.toUpperCase() || '',
    dob: fiData.dob || '',
    location: fiData.location?.toUpperCase() || '',
    description: fiData.description || '',
    notes: fiData.notes || '',
    officer: user?.unit_id || user?.username
  });
}

export async function getFleetUnits(user) {
  const result = await cadRequest('/api/radio/fleet/units', 'GET');
  if (result.success === false) {
    return { 
      units: [{ id: user?.unit_id || 'UNIT1', name: user?.unit_id || 'UNIT1' }],
      statusOptions: ['In Service', 'Out of Service', 'Available', 'En Route', 'On Scene']
    };
  }
  return result;
}

export async function updateFleetUnitStatus(unitId, status) {
  console.log(`[CAD] Fleet status update: ${unitId} -> ${status}`);
  return cadRequest(`/api/radio/fleet/unit/${encodeURIComponent(unitId)}/status`, 'POST', { status });
}

export async function addFuelEntry(unitId, fuelData) {
  console.log(`[CAD] Fuel entry for ${unitId}:`, fuelData);
  return cadRequest(`/api/radio/fleet/unit/${encodeURIComponent(unitId)}/fuel`, 'POST', {
    miles: parseFloat(fuelData.miles) || 0,
    gallons: parseFloat(fuelData.gallons) || 0,
    cost: parseFloat(fuelData.cost) || 0,
    station: fuelData.station || ''
  });
}

export async function getRecentBolos() {
  const result = await cadRequest('/api/radio/bolo/recent', 'GET');
  if (result.success === false) {
    return { bolos: [] };
  }
  return result;
}

export async function getMessages(user) {
  const unitId = user?.unit_id || user?.username;
  return cadRequest(`/api/radio/messages?unit_id=${encodeURIComponent(unitId)}`, 'GET');
}

export async function getUnreadCount(user) {
  const unitId = user?.unit_id || user?.username;
  const result = await cadRequest(`/api/radio/messages/unread?unit_id=${encodeURIComponent(unitId)}`, 'GET');
  if (result.success === false) {
    return { count: 0 };
  }
  return result;
}

export async function getConversation(conversationId, user) {
  return cadRequest(`/api/radio/messages/conversation/${conversationId}`, 'GET');
}

export async function sendMessage(conversationId, message, user) {
  console.log(`[CAD] Sending message to ${conversationId}`);
  return cadRequest('/api/radio/messages/reply', 'POST', {
    conversation_id: conversationId,
    message,
    sender: user?.unit_id || user?.username
  });
}
