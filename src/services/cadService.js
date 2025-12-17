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
      'X-API-Key': CAD_API_KEY
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
  console.log(`[CAD] Person query: ${firstName} ${lastName}`);
  const body = {
    first_name: firstName.toUpperCase(),
    last_name: lastName.toUpperCase()
  };
  if (dob) body.dob = dob;
  return cadRequest('/api/radio/query/person', 'POST', body);
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
