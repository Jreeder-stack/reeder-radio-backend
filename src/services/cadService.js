function getUnitId(user) {
  return user?.unit_id || user?.username || null;
}

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
  if (!unitId) {
    console.warn('[CAD] respondToStatusCheck: No unit ID provided');
    return { success: false, error: 'No unit ID' };
  }
  return cadRequest('/api/radio/respond-check', 'POST', {
    unit_id: unitId,
    status
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
