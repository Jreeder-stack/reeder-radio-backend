function getUnitId(user) {
  return user?.unit_id || user?.username || null;
}

export const RADIO_STATUS = {
  AVAILABLE:          'OD',
  OFF_DUTY:           'OFDTY',
  EN_ROUTE_PRIMARY:   'ENRT',
  ON_SCENE:           'ARVD',
  EN_ROUTE_SECONDARY: 'ENRTS',
  ARRIVED_SECONDARY:  'ARRVDS',
  OUT_OF_VEHICLE:     'OOV',
  OUT_OF_SERVICE:     'OOS',
  COURT:              'COURT',
  TRAINING:           'TRAIN',
};

export function extractActualStatusFromRejection(cadResult) {
  if (!cadResult || cadResult.success !== false) return null;
  const rb = cadResult.responseBody;
  if (!rb || typeof rb !== 'object') return null;
  const raw = rb.current_status
    || rb.currentStatus
    || rb.actual_status
    || rb.unit_status
    || rb.status
    || null;
  if (!raw) return null;
  const code = String(raw).toUpperCase().trim();
  const SPOKEN = {
    OD:     'available',
    OFDTY:  'off duty',
    ENRT:   'en route',
    ARVD:   'on scene',
    ENRTS:  'en route to a secondary',
    ARRVDS: 'arrived at a secondary',
    OOV:    'out of vehicle',
    OOS:    'out of service',
    COURT:  'in court',
    TRAIN:  'in training',
  };
  return SPOKEN[code] || raw;
}

async function cadRequest(endpoint, method = 'GET', body = null) {
  const CAD_URL = process.env.CAD_URL;
  const CAD_API_KEY = process.env.CAD_API_KEY;
  
  if (!CAD_URL || !CAD_API_KEY) {
    console.warn('[CAD] Integration not configured - missing CAD_URL or CAD_API_KEY');
    return { success: false, error: 'CAD integration not configured', failureType: 'NOT_CONFIGURED', statusCode: null, responseBody: null };
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
    console.log(`[CAD] Outgoing ${method} ${endpoint} payload: ${options.body}`);
  }

  try {
    const response = await fetch(url, options);

    if (response.status === 204) {
      return { success: true, statusCode: 204 };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      const textBody = await response.text().catch(() => '(unable to read body)');
      console.error(`[CAD] Non-JSON response from ${url} (status ${response.status}, content-type: ${contentType}), body: ${textBody}`);
      return { success: false, error: `Non-JSON response (status ${response.status}, content-type: ${contentType})`, failureType: 'UNREACHABLE', statusCode: response.status, responseBody: textBody };
    }

    const data = await response.json();
    
    if (!response.ok) {
      console.error(`[CAD] API error: ${method} ${endpoint} status=${response.status}, response=${JSON.stringify(data)}`);
      return { success: false, error: data.error || `HTTP ${response.status}`, failureType: 'API_REJECTION', statusCode: response.status, responseBody: data };
    }
    
    if (data && data.success === false) {
      console.warn(`[CAD] Application-level failure for ${method} ${endpoint}: status=${response.status}, body=${JSON.stringify(data)}`);
      return {
        ...data,
        success: false,
        error: data.error || 'Application-level failure',
        failureType: data.failureType || 'API_REJECTION',
        statusCode: response.status,
        responseBody: data
      };
    }
    
    return data;
  } catch (error) {
    console.error(`[CAD] Request failed for ${method} ${endpoint}:`, error.message);
    return { success: false, error: error.message, failureType: 'UNREACHABLE', statusCode: null, responseBody: null };
  }
}

export async function updateUnitStatus(unitId, status, channel = null) {
  if (!unitId) {
    console.warn('[CAD] updateUnitStatus: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  console.log(`[CAD] Updating status: ${unitId} -> ${status}`);
  return cadRequest('/api/radio/status', 'POST', {
    unit_id: unitId,
    status: status,
    channel: channel
  });
}

export async function updateUnitZone(unitId, zone) {
  if (!unitId) {
    console.warn('[CAD] updateUnitZone: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
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
  if (!unitId) {
    console.warn('[CAD] cycleUnitStatus: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  console.log(`[CAD] Cycling status for ${unitId}`);
  return cadRequest(`/api/radio/unit/${encodeURIComponent(unitId)}/status/cycle`, 'POST');
}

const PRIORITY_MAP = {
  'low': 5,
  'medium': 3,
  'high': 2,
  'critical': 1,
  'emergency': 1
};

function parseMunicipalityFromAddress(address) {
  if (!address) return '';
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const candidate = parts[1].replace(/\b[A-Z]{2}\b\s*\d{0,5}$/, '').trim();
    if (candidate.length > 1) return candidate;
  }
  return '';
}

function normalizePriority(priority) {
  if (typeof priority === 'number' && priority >= 1 && priority <= 5) return String(priority);
  if (typeof priority === 'string') {
    const num = parseInt(priority, 10);
    if (!isNaN(num) && num >= 1 && num <= 5) return String(num);
    return String(PRIORITY_MAP[priority.toLowerCase()] || 3);
  }
  return String(3);
}

export async function createCall(type, priority, location, municipality, notes = '', units = []) {
  if (!type) {
    console.error('[CAD] createCall: type is required but was', type);
    return { success: false, error: 'Call type is required', failureType: 'INVALID_INPUT', statusCode: null, responseBody: null };
  }
  if (!location) {
    console.error('[CAD] createCall: location is required but was', location);
    return { success: false, error: 'Call location is required', failureType: 'INVALID_INPUT', statusCode: null, responseBody: null };
  }
  const safeUnits = Array.isArray(units) ? units : [];
  console.log(`[CAD] Creating call: type=${type}, priority=${priority}, location=${location}, municipality=${municipality}, units=${JSON.stringify(safeUnits)}`);
  const resolvedMunicipality = (municipality && municipality.trim()) ? municipality.trim() : parseMunicipalityFromAddress(location);
  let finalLocation = location;
  if (resolvedMunicipality && location.includes(',')) {
    const parts = location.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      finalLocation = parts[0];
    }
  }
  const numericPriority = normalizePriority(priority);
  const body = {
    type: type.toUpperCase(),
    priority: numericPriority,
    location: finalLocation.toUpperCase(),
    municipality: resolvedMunicipality ? resolvedMunicipality.toUpperCase() : '',
    notes: notes || '',
    units: safeUnits
  };
  return cadRequest('/api/radio/call', 'POST', body);
}

export async function getUnitInfo(unitId) {
  if (!unitId) {
    console.warn('[CAD] getUnitInfo: No unit ID provided');
    return null;
  }
  try {
    const result = await getStatusCheck();
    if (result.success && Array.isArray(result.units)) {
      const unit = result.units.find(u =>
        u.unit_id && u.unit_id.toUpperCase() === unitId.toUpperCase()
      );
      if (unit) {
        return {
          unitId: unit.unit_id,
          status: unit.status,
          zone: unit.zone || null,
          currentLocation: unit.current_location || null,
          latitude: unit.latitude ? parseFloat(unit.latitude) : null,
          longitude: unit.longitude ? parseFloat(unit.longitude) : null,
          agency: unit.agency || null
        };
      }
    }
    return null;
  } catch (error) {
    console.error('[CAD] getUnitInfo failed:', error.message);
    return null;
  }
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
  if (!unitId) {
    console.warn('[CAD] assignUnitToCall: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  console.log(`[CAD] Assigning ${unitId} to call ${callId}`);
  return cadRequest('/api/radio/assign', 'POST', {
    unit_id: unitId,
    call_id: callId
  });
}

// Task #486 (Step 7): promote a unit already assigned to a call to be the
// primary unit on that call. CAD does not expose a dedicated endpoint, so
// patch the call record with primary_unit set to the unit id.
export async function setPrimaryUnit(callId, unitId) {
  if (!callId) return { success: false, error: 'No call ID' };
  if (!unitId) return { success: false, error: 'No unit ID' };
  console.log(`[CAD] Setting primary unit on call ${callId} to ${unitId}`);
  return cadRequest(`/api/radio/call/${callId}`, 'PATCH', {
    primary_unit: unitId,
    primaryUnit: unitId,
  });
}

export async function clearUnit(unitId) {
  if (!unitId) {
    console.warn('[CAD] clearUnit: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  console.log(`[CAD] Clearing ${unitId} from call`);
  return cadRequest('/api/radio/clear', 'POST', {
    unit_id: unitId
  });
}

export async function disposeCall(callId, disposition, dispositionNotes = null) {
  if (!callId) {
    return { success: false, error: 'No call ID', failureType: 'INVALID_INPUT' };
  }
  if (!disposition || !String(disposition).trim()) {
    return { success: false, error: 'Disposition required (R9)', failureType: 'INVALID_INPUT' };
  }
  const notes = (dispositionNotes && String(dispositionNotes).trim())
    ? String(dispositionNotes).trim()
    : String(disposition).trim();
  console.log(`[CAD] Disposing call ${callId}: ${disposition} | notes=${notes}`);
  return cadRequest('/api/radio/dispose', 'POST', {
    call_id: callId,
    disposition,
    dispositionNotes: notes,
    disposition_notes: notes
  });
}

// SEQ-10: Cancel call. Bypass /api/radio/* (which only closes) and PUT
// /api/calls/:callId directly so CAD records status=cancelled with both
// disposition and dispositionNotes (R9).
export async function cancelCallDirect(callId, disposition, dispositionNotes = null) {
  if (!callId) {
    return { success: false, error: 'No call ID', failureType: 'INVALID_INPUT' };
  }
  if (!disposition || !String(disposition).trim()) {
    return { success: false, error: 'Disposition required (R9)', failureType: 'INVALID_INPUT' };
  }
  const notes = (dispositionNotes && String(dispositionNotes).trim())
    ? String(dispositionNotes).trim()
    : String(disposition).trim();
  console.log(`[CAD] Cancelling call ${callId}: ${disposition} | notes=${notes}`);
  return cadRequest(`/api/calls/${encodeURIComponent(callId)}`, 'PUT', {
    status: 'cancelled',
    disposition,
    dispositionNotes: notes
  });
}

// SEQ-11: Reopen a closed call. CAD has no /api/radio/reopen, so use the
// generic unit-command channel with REOPEN/<callNumber>.
export async function reopenCall(callNumber) {
  if (!callNumber) {
    return { success: false, error: 'No call number', failureType: 'INVALID_INPUT' };
  }
  console.log(`[CAD] Reopening call ${callNumber}`);
  return cadRequest('/api/unit-command', 'POST', {
    command: `REOPEN/${callNumber}`
  });
}

export async function addCallNote(callId, note) {
  return cadRequest('/api/radio/note', 'POST', {
    call_id: callId,
    note
  });
}

export async function deleteCallNote(noteId) {
  if (!noteId) {
    return { success: false, error: 'No note ID', failureType: 'INVALID_INPUT' };
  }
  console.log(`[CAD] Deleting call note ${noteId}`);
  return cadRequest(`/api/radio/note/${encodeURIComponent(noteId)}`, 'DELETE');
}

export async function cancelCall(callId, reason = 'Created in error') {
  // Legacy entrypoint preserved for the CREATE_CALL inverse-action path.
  // Routes through cancelCallDirect so the call lands in status=cancelled
  // (not closed) with both R9-required fields populated.
  return cancelCallDirect(callId, reason, reason);
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

export async function queryPersonByDL(dlNumber, dlState) {
  const body = {
    dl_number: dlNumber.toUpperCase(),
    dl_state: dlState.toUpperCase()
  };
  console.log(`[CAD] Person DL query request: state=${dlState.toUpperCase()}`);
  const result = await cadRequest('/api/radio/query/person/dl', 'POST', body);
  console.log(`[CAD] Person DL query response: success=${result.success}, count=${result.count ?? (result.results?.length ?? 'n/a')}`);
  return result;
}

export async function queryPersonBySSN(ssn) {
  const body = {
    ssn: ssn.replace(/[^0-9]/g, '')
  };
  console.log(`[CAD] Person SSN query request`);
  const result = await cadRequest('/api/radio/query/person/ssn', 'POST', body);
  console.log(`[CAD] Person SSN query response: success=${result.success}, count=${result.count ?? (result.results?.length ?? 'n/a')}`);
  return result;
}

export async function getUnitCurrentCallById(unitId) {
  if (!unitId) {
    console.warn('[CAD] getUnitCurrentCallById: No unit ID provided');
    return { callNumber: null };
  }
  console.log(`[CAD] Getting current call for ${unitId}`);
  const result = await cadRequest(`/api/radio/unit/${encodeURIComponent(unitId)}/call`, 'GET');
  if (result.success === false) {
    return { callNumber: null };
  }
  if (result && result.has_active_call === true && result.call && typeof result.call === 'object') {
    return {
      ...result.call,
      unit_id: result.unit_id,
      has_active_call: true,
      call: result.call,
    };
  }
  if (result && result.has_active_call === false) {
    return { callNumber: null, has_active_call: false };
  }
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

export async function getPendingChecks(lookaheadSec = null) {
  const qs = lookaheadSec ? `?lookahead_sec=${encodeURIComponent(lookaheadSec)}` : '';
  return cadRequest(`/api/radio/pending-checks${qs}`, 'GET');
}

export async function respondToStatusCheck(unitId, callId, status = 'ok') {
  if (!unitId) {
    console.warn('[CAD] respondToStatusCheck: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  const body = { unit_id: unitId };
  if (callId) body.call_id = callId;
  if (status) body.status = status;
  return cadRequest('/api/radio/respond-check', 'POST', body);
}

export async function snoozeStatusCheck(unitId, callId, durationSec) {
  if (!unitId) {
    console.warn('[CAD] snoozeStatusCheck: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  const body = { unit_id: unitId, duration_sec: durationSec };
  if (callId) body.call_id = callId;
  return cadRequest('/api/radio/snooze-check', 'POST', body);
}

export async function cancelStatusCheck(unitId, callId) {
  if (!unitId) {
    console.warn('[CAD] cancelStatusCheck: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  if (!callId) {
    console.warn('[CAD] cancelStatusCheck: No call ID provided — refusing to cancel');
    return { success: false, error: 'No call ID' };
  }
  return cadRequest('/api/radio/cancel-check', 'POST', {
    unit_id: unitId,
    call_id: callId
  });
}

export function isConfigured() {
  return !!(process.env.CAD_URL && process.env.CAD_API_KEY);
}

let cachedCallNatures = [];
let naturesLastFetched = 0;
const NATURES_CACHE_TTL_MS = 30 * 60 * 1000;

export async function getCallNatures(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCallNatures.length > 0 && (now - naturesLastFetched) < NATURES_CACHE_TTL_MS) {
    return cachedCallNatures;
  }

  try {
    const result = await cadRequest('/api/radio/call-natures', 'GET');
    if (result.success && Array.isArray(result.call_natures) && result.call_natures.length > 0) {
      cachedCallNatures = result.call_natures.map(n => n.key || n.name).filter(Boolean);
      naturesLastFetched = now;
      console.log(`[CAD] Loaded ${cachedCallNatures.length} call natures from CAD`);
      return cachedCallNatures;
    }
  } catch (error) {
    console.error('[CAD] Failed to fetch call natures:', error.message);
  }

  if (cachedCallNatures.length > 0) {
    console.log('[CAD] Using previously cached call natures');
    return cachedCallNatures;
  }

  cachedCallNatures = [
    'ASSAULT', 'BURGLARY', 'DOMESTIC', 'DISTURBANCE', 'DUI', 'DRUG ACTIVITY',
    'FIRE', 'EMS', 'HARASSMENT', 'MISSING PERSON', 'NOISE COMPLAINT',
    'ROBBERY', 'SHOTS FIRED', 'SUSPICIOUS PERSON', 'SUSPICIOUS VEHICLE',
    'THEFT', 'THEFT - RETAIL', 'TRESPASS', 'VANDALISM', 'WARRANT SERVICE',
    'WELFARE CHECK', 'ACCIDENT', 'ACCIDENT - INJURY', 'ACCIDENT - HIT AND RUN',
    'ALARM', 'CIVIL STANDBY', 'ANIMAL COMPLAINT', 'PURSUIT', 'UNKNOWN TYPE'
  ];
  naturesLastFetched = now;
  console.log('[CAD] Using default call natures fallback list');
  return cachedCallNatures;
}

export async function findBestNature(spokenNature) {
  if (!spokenNature) return 'UNKNOWN TYPE';
  const spoken = spokenNature.toUpperCase().trim();
  if (!spoken) return 'UNKNOWN TYPE';

  if (cachedCallNatures.length === 0) {
    await getCallNatures();
  }

  const natures = cachedCallNatures.length > 0 ? cachedCallNatures : [];
  if (natures.length === 0) return spoken;

  const exactMatch = natures.find(n => n === spoken);
  if (exactMatch) return exactMatch;

  const startsWithMatch = natures.find(n => n.startsWith(spoken) || spoken.startsWith(n));
  if (startsWithMatch) return startsWithMatch;

  const containsMatch = natures.find(n => n.includes(spoken) || spoken.includes(n));
  if (containsMatch) return containsMatch;

  const spokenWords = spoken.split(/[\s\-]+/).filter(w => w.length > 1);
  let bestMatch = null;
  let bestScore = 0;
  for (const nature of natures) {
    const natureWords = nature.split(/[\s\-]+/).filter(w => w.length > 1);
    let score = 0;
    for (const sw of spokenWords) {
      for (const nw of natureWords) {
        if (nw === sw) score += 3;
        else if (nw.includes(sw) || sw.includes(nw)) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = nature;
    }
  }

  if (bestMatch && bestScore >= 1) return bestMatch;

  return spoken;
}

// Task #482: CAD canonical dispositions list. Cached for 5 minutes,
// stale-on-error fallback so the AI keeps working when CAD blips.
let cachedDispositions = [];
let dispositionsLastFetched = 0;
const DISPOSITIONS_CACHE_TTL_MS = 5 * 60 * 1000;

function _normalizeDispositionsResponse(result) {
  if (!result) return null;
  let arr = null;
  if (Array.isArray(result)) arr = result;
  else if (Array.isArray(result.options)) arr = result.options;
  else if (Array.isArray(result.dispositions)) arr = result.dispositions;
  else if (Array.isArray(result.results)) arr = result.results;
  else if (Array.isArray(result.data)) arr = result.data;
  if (!arr) return null;
  const out = [];
  for (const o of arr) {
    if (typeof o === 'string') {
      const v = o.trim();
      if (v) out.push({ value: v, label: v });
    } else if (o && typeof o === 'object') {
      const value = o.value || o.key || o.code || o.name || o.label;
      const label = o.label || o.name || o.value || o.key;
      if (value) out.push({ value: String(value).trim(), label: String(label || value).trim() });
    }
  }
  return out.length ? out : null;
}

export async function getDispositions(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedDispositions.length > 0 && (now - dispositionsLastFetched) < DISPOSITIONS_CACHE_TTL_MS) {
    return cachedDispositions;
  }
  try {
    const result = await cadRequest('/api/dropdown-options?category=dispositions', 'GET');
    if (result && result.success !== false) {
      const norm = _normalizeDispositionsResponse(result);
      if (norm && norm.length) {
        cachedDispositions = norm;
        dispositionsLastFetched = now;
        console.log(`[CAD] Loaded ${cachedDispositions.length} dispositions from CAD`);
        return cachedDispositions;
      }
    }
  } catch (e) {
    console.error('[CAD] Failed to fetch dispositions:', e.message);
  }
  if (cachedDispositions.length > 0) {
    console.log('[CAD] Using previously cached dispositions (stale)');
    return cachedDispositions;
  }
  return [];
}

const DISPOSITION_SYNONYMS = {
  'report': 'report taken',
  'reports': 'report taken',
  'report taken': 'report taken',
  'reports taken': 'report taken',
  'report filed': 'report taken',
  'wrote a report': 'report taken',
  'with a report': 'report taken',
  'warning': 'warning issued',
  'warnings': 'warning issued',
  'warning issued': 'warning issued',
  'verbal warning': 'warning issued',
  'gave a warning': 'warning issued',
  'citation': 'citation issued',
  'citations': 'citation issued',
  'citation issued': 'citation issued',
  'cite': 'citation issued',
  'cited': 'citation issued',
  'ticket': 'citation issued',
  'arrest': 'arrest made',
  'arrest made': 'arrest made',
  'arrested': 'arrest made',
  'in custody': 'arrest made',
  'unfounded': 'unfounded',
  'goa': 'gone on arrival',
  'gone on arrival': 'gone on arrival',
  'utl': 'unable to locate',
  'unable to locate': 'unable to locate',
  'no contact': 'negative contact',
  'negative contact': 'negative contact',
  '10-91': 'negative contact',
  '1091': 'negative contact',
  'cancel': 'cancelled',
  'cancelled': 'cancelled',
  'canceled': 'cancelled',
  'no report': 'no report',
};

function _normDispText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchDisposition(spoken, list) {
  if (!spoken || !Array.isArray(list) || list.length === 0) return null;
  const normSpoken = _normDispText(spoken);
  if (!normSpoken) return null;

  const canonicalNorm = list.map(d => ({
    item: d,
    normValue: _normDispText(d.value),
    normLabel: _normDispText(d.label),
  }));

  // 1. Exact match
  for (const c of canonicalNorm) {
    if (normSpoken === c.normValue || normSpoken === c.normLabel) {
      return { canonical: c.item.value, score: 1.0 };
    }
  }

  // 2. Synonym expansion (single-pass keyword lookup)
  let expanded = DISPOSITION_SYNONYMS[normSpoken] || null;
  if (!expanded) {
    for (const key of Object.keys(DISPOSITION_SYNONYMS)) {
      if (normSpoken.includes(key)) {
        expanded = DISPOSITION_SYNONYMS[key];
        break;
      }
    }
  }
  if (expanded) {
    for (const c of canonicalNorm) {
      if (expanded === c.normValue || expanded === c.normLabel) {
        return { canonical: c.item.value, score: 0.95 };
      }
    }
  }

  const candidate = expanded || normSpoken;

  // 3. Substring (either direction)
  let bestSub = null;
  for (const c of canonicalNorm) {
    if (!c.normLabel && !c.normValue) continue;
    const labelHit = c.normLabel && (c.normLabel.includes(candidate) || candidate.includes(c.normLabel));
    const valueHit = c.normValue && (c.normValue.includes(candidate) || candidate.includes(c.normValue));
    if (labelHit || valueHit) {
      const score = 0.8;
      if (!bestSub || score > bestSub.score) bestSub = { canonical: c.item.value, score };
    }
  }
  if (bestSub) return bestSub;

  // 4. Token overlap
  const spokenTokens = new Set(candidate.split(/\s+/).filter(t => t.length > 1));
  if (spokenTokens.size === 0) return null;
  let bestTok = null;
  for (const c of canonicalNorm) {
    const labelTokens = new Set((c.normLabel || '').split(/\s+/).filter(t => t.length > 1));
    if (!labelTokens.size) continue;
    let overlap = 0;
    for (const t of spokenTokens) if (labelTokens.has(t)) overlap++;
    const score = overlap / Math.max(spokenTokens.size, labelTokens.size);
    if (score >= 0.5 && (!bestTok || score > bestTok.score)) {
      bestTok = { canonical: c.item.value, score };
    }
  }
  return bestTok;
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
  const unitId = getUnitId(user);
  if (!unitId) {
    console.warn('[CAD] createCitation: No unit ID available');
    return { success: false, error: 'No unit ID' };
  }
  console.log(`[CAD] Creating ${type} from ${populateFrom}`);
  return cadRequest('/api/radio/citation/new', 'POST', {
    type,
    populate_from: populateFrom,
    unit_id: unitId
  });
}

export async function getMapUrl() {
  const CAD_URL = process.env.CAD_URL;
  if (!CAD_URL) return null;
  return `${CAD_URL}/map`;
}

export async function getUnitCurrentCall(user) {
  const unitId = getUnitId(user);
  if (!unitId) {
    console.warn('[CAD] getUnitCurrentCall: No unit ID available');
    return { callNumber: null };
  }
  console.log(`[CAD] Getting current call for ${unitId}`);
  const result = await cadRequest(`/api/radio/unit/${encodeURIComponent(unitId)}/call`, 'GET');
  if (result.success === false) {
    return { callNumber: null };
  }
  return result;
}

export async function createFieldInterview(fiData, user) {
  const officerId = fiData.officer || getUnitId(user) || 'UNKNOWN';
  console.log('[CAD] Creating FI:', fiData);
  return cadRequest('/api/radio/fi/create', 'POST', {
    call_number: fiData.callNumber || '',
    other_number: fiData.otherNumber || '',
    date: fiData.date || '',
    time: fiData.time || '',
    officer: officerId,
    agency: fiData.agency || '',
    location: fiData.location?.toUpperCase() || '',
    x_street: fiData.xStreet?.toUpperCase() || '',
    city: fiData.city?.toUpperCase() || '',
    state: fiData.state || '',
    zip: fiData.zip || '',
    county: fiData.county?.toUpperCase() || '',
    reason: fiData.reason || '',
    last_name: fiData.lastName?.toUpperCase() || '',
    first_name: fiData.firstName?.toUpperCase() || '',
    middle_name: fiData.middleName?.toUpperCase() || '',
    dob: fiData.dob || '',
    sex: fiData.sex || '',
    race: fiData.race || '',
    height_ft: fiData.heightFt || '',
    height_in: fiData.heightIn || '',
    weight: fiData.weight || '',
    eyes: fiData.eyes || '',
    hair: fiData.hair || '',
    dl_number: fiData.dlNumber || '',
    dl_state: fiData.dlState || '',
    phone: fiData.phone || '',
    work_phone: fiData.workPhone || '',
    street_address: fiData.streetAddress?.toUpperCase() || '',
    unit: fiData.unit || '',
    person_city: fiData.personCity?.toUpperCase() || '',
    person_state: fiData.personState || '',
    person_zip: fiData.personZip || '',
    clothing: fiData.clothing || '',
    veh_license: fiData.vehLicense?.toUpperCase() || '',
    veh_state: fiData.vehState || '',
    veh_tag: fiData.vehTag || '',
    veh_year: fiData.vehYear || '',
    veh_vin: fiData.vehVin?.toUpperCase() || '',
    veh_type: fiData.vehType || '',
    veh_make: fiData.vehMake?.toUpperCase() || '',
    veh_model: fiData.vehModel?.toUpperCase() || '',
    veh_style: fiData.vehStyle || '',
    veh_color: fiData.vehColor || '',
    veh_comment: fiData.vehComment || '',
    was_trespassed: fiData.wasTrespassed || false,
    trespass_expires: fiData.trespassExpires || '',
    indefinite_trespass: fiData.indefiniteTrespass || false,
    trespass_type: fiData.trespassType || '',
    business_name: fiData.businessName?.toUpperCase() || '',
    trespass_address: fiData.trespassAddress?.toUpperCase() || '',
    trespass_city: fiData.trespassCity?.toUpperCase() || '',
    trespass_state: fiData.trespassState || '',
    trespass_reason: fiData.trespassReason || ''
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
  if (!unitId) {
    console.warn('[CAD] updateFleetUnitStatus: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  console.log(`[CAD] Fleet status update: ${unitId} -> ${status}`);
  return cadRequest(`/api/radio/fleet/unit/${encodeURIComponent(unitId)}/status`, 'POST', { status });
}

export async function addFuelEntry(unitId, fuelData) {
  if (!unitId) {
    console.warn('[CAD] addFuelEntry: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
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

export async function getContacts(user) {
  console.log('[CAD] Getting contacts');
  const result = await cadRequest('/api/radio/contacts', 'GET');
  if (result.success === false) {
    return { contacts: [] };
  }
  return result;
}

export async function getChats(user) {
  console.log('[CAD] Getting chat threads');
  const result = await cadRequest('/api/radio/chats', 'GET');
  if (result.success === false) {
    return { chats: [] };
  }
  return result;
}

export async function createChat(recipientId, message, user) {
  const senderId = getUnitId(user);
  if (!senderId) {
    console.warn('[CAD] createChat: No sender ID available');
    return { success: false, error: 'No sender ID' };
  }
  console.log(`[CAD] Creating new chat with ${recipientId}`);
  return cadRequest('/api/radio/chats', 'POST', {
    recipient_id: recipientId,
    message,
    sender: senderId
  });
}

export async function deleteChat(chatId) {
  console.log(`[CAD] Deleting chat ${chatId}`);
  return cadRequest(`/api/radio/chats/${chatId}`, 'DELETE');
}

export async function getChatMessages(chatId, user) {
  console.log(`[CAD] Getting messages for chat ${chatId}`);
  return cadRequest(`/api/radio/chats/${chatId}/messages`, 'GET');
}

export async function sendChatMessage(chatId, message, user) {
  const senderId = getUnitId(user);
  if (!senderId) {
    console.warn('[CAD] sendChatMessage: No sender ID available');
    return { success: false, error: 'No sender ID' };
  }
  console.log(`[CAD] Sending message to chat ${chatId}`);
  return cadRequest(`/api/radio/chats/${chatId}/messages`, 'POST', {
    message,
    sender: senderId
  });
}

export async function getUnreadCount(user) {
  const unitId = getUnitId(user);
  if (!unitId) {
    console.warn('[CAD] getUnreadCount: No unit ID available');
    return { count: 0 };
  }
  const result = await cadRequest(`/api/radio/messages/unread?unit_id=${encodeURIComponent(unitId)}`, 'GET');
  if (result.success === false) {
    return { count: 0 };
  }
  return result;
}

const DROPDOWN_DESCRIPTION_MAP = {
  'Pennsylvania counties': 'counties',
  'Biological sex options': 'sexOptions',
  'Sex/gender codes': 'sexOptions',
  'Race/ethnicity options': 'raceOptions',
  'Race classification codes': 'raceOptions',
  'Eye color options': 'eyeColors',
  'Eye Color dropdown options': 'eyeColors',
  'Hair color options': 'hairColors',
  'Hair Color dropdown options': 'hairColors',
  'Standard vehicle colors': 'vehicleColors',
  'Vehicle body style types': 'vehicleTypes',
  'Vehicle Styles dropdown options': 'vehicleStyles',
  'Body styles for vehicles': 'vehicleStyles'
};

const DEFAULT_CONFIG = {
  counties: [],
  sexOptions: ['Male', 'Female', 'Unknown'],
  raceOptions: ['White', 'Black', 'Hispanic', 'Asian', 'Native American', 'Pacific Islander', 'Other', 'Unknown'],
  eyeColors: ['Brown', 'Blue', 'Green', 'Hazel', 'Gray', 'Black', 'Unknown'],
  hairColors: ['Black', 'Brown', 'Blonde', 'Red', 'Gray', 'White', 'Bald', 'Unknown'],
  vehicleTypes: ['Sedan', 'SUV', 'Truck', 'Van', 'Motorcycle', 'Other'],
  vehicleStyles: ['2-Door', '4-Door', 'Hatchback', 'Convertible', 'Pickup', 'Other'],
  vehicleColors: ['Black', 'White', 'Silver', 'Gray', 'Red', 'Blue', 'Green', 'Brown', 'Tan', 'Gold', 'Orange', 'Yellow', 'Purple', 'Other']
};

export async function getSystemConfig() {
  console.log('[CAD] Getting system config via dropdown API');
  
  try {
    const categoriesResult = await cadRequest('/api/radio/dropdowns', 'GET');
    
    if (!categoriesResult.success || !categoriesResult.categories) {
      console.log('[CAD] Failed to fetch dropdown categories, using defaults');
      return DEFAULT_CONFIG;
    }
    
    const categoryMap = {};
    for (const cat of categoriesResult.categories) {
      if (cat.description && DROPDOWN_DESCRIPTION_MAP[cat.description]) {
        const fieldName = DROPDOWN_DESCRIPTION_MAP[cat.description];
        if (!categoryMap[fieldName]) {
          categoryMap[fieldName] = cat.id;
        }
      }
    }
    
    console.log('[CAD] Found category mappings:', Object.keys(categoryMap));
    
    const config = { ...DEFAULT_CONFIG };
    
    const fetchPromises = Object.entries(categoryMap).map(async ([fieldName, categoryId]) => {
      try {
        const result = await cadRequest(`/api/radio/dropdowns/${categoryId}`, 'GET');
        if (result.success && result.options && Array.isArray(result.options)) {
          const values = result.options.map(opt => opt.value || opt.label || opt.name || opt);
          if (values.length > 0) {
            config[fieldName] = values;
            console.log(`[CAD] Loaded ${values.length} options for ${fieldName}`);
          }
        }
      } catch (err) {
        console.log(`[CAD] Failed to fetch ${fieldName} options:`, err.message);
      }
    });
    
    await Promise.all(fetchPromises);
    
    return config;
  } catch (err) {
    console.log('[CAD] Error fetching system config:', err.message);
    return DEFAULT_CONFIG;
  }
}
