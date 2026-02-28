const DISPATCHER_STATE = {
  IDLE: 'IDLE',
  AWAITING_COMMAND: 'AWAITING_COMMAND',
  AWAITING_PLATE: 'AWAITING_PLATE',
  AWAITING_NAME: 'AWAITING_NAME',
  AWAITING_LOCATION: 'AWAITING_LOCATION',
  AWAITING_DESCRIPTION: 'AWAITING_DESCRIPTION',
  AWAITING_PERSON_DETAILS: 'AWAITING_PERSON_DETAILS',
  AWAITING_PERSON_DOB: 'AWAITING_PERSON_DOB',
  AWAITING_SECURE_CONFIRM: 'AWAITING_SECURE_CONFIRM',
  AWAITING_PERSON_CONFIRM: 'AWAITING_PERSON_CONFIRM',
  AWAITING_PERSON_FIRSTNAME: 'AWAITING_PERSON_FIRSTNAME',
  AWAITING_ZONE: 'AWAITING_ZONE',
  AWAITING_ZONE_CONFIRM: 'AWAITING_ZONE_CONFIRM',
  AWAITING_DETAIL_LOCATION: 'AWAITING_DETAIL_LOCATION',
  AWAITING_DETAIL_CONFIRM: 'AWAITING_DETAIL_CONFIRM',
  SIGNAL_100_ACTIVE: 'SIGNAL_100_ACTIVE'
};

const unitSessions = new Map();

const SESSION_TIMEOUT_MS = 45000;
const SIGNAL_100_TIMEOUT_MS = 300000;

function getUnitSession(unitId) {
  if (!unitSessions.has(unitId)) {
    unitSessions.set(unitId, {
      state: DISPATCHER_STATE.IDLE,
      pendingIntent: null,
      slots: {},
      timeout: null,
      lastActivity: Date.now()
    });
  }
  return unitSessions.get(unitId);
}

function resetUnitSession(unitId) {
  const session = unitSessions.get(unitId);
  if (session?.timeout) {
    clearTimeout(session.timeout);
  }
  unitSessions.set(unitId, {
    state: DISPATCHER_STATE.IDLE,
    pendingIntent: null,
    slots: {},
    timeout: null,
    lastActivity: Date.now()
  });
}

function startSessionTimeout(unitId) {
  const session = getUnitSession(unitId);
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  session.timeout = setTimeout(() => {
    resetUnitSession(unitId);
  }, SESSION_TIMEOUT_MS);
}

const STATUS_COMMANDS = [
  { 
    phrases: [
      'on duty', 'on-duty', 'onduty', 'on doody', 'on dudy', 'on duety',
      'in service', 'signed on', 'clocked in', 'starting shift',
      '10-8', '10/8', '10 8', 'ten eight', 'ten-eight'
    ], 
    status: 'on duty',
    cadStatus: 'on_duty',
    isEmergency: false
  },
  { 
    phrases: [
      'available', 'avail', 'a vailable', 'clear and available',
      'back in service', 'ready', 'free',
      '10-8 available', '10/8 available', 'ten eight available'
    ], 
    status: 'available',
    cadStatus: 'available',
    isEmergency: false
  },
  { 
    phrases: [
      'en route', 'enroute', 'on route', 'in route', 'inroute', 'in rout',
      'on my way', 'heading that way', 'rolling',
      '10-76', '10/76', '10 76', 'ten seventy six', 'ten-seventy-six', '1076'
    ], 
    status: 'en route',
    cadStatus: 'en_route',
    isEmergency: false
  },
  { 
    phrases: [
      'on scene', 'on seen', 'onscene', 'on-scene', 'on scn', 'on sene', 'at scene',
      'on location', 'onlocation', 'on-location', 'at location', 'arrived',
      '10-97', '10/97', '10 97', 'ten ninety seven', 'ten-ninety-seven', '1097'
    ], 
    status: 'on scene',
    cadStatus: 'on_scene',
    isEmergency: false
  },
  { 
    phrases: [
      'off duty', 'off-duty', 'offduty', 'off doody', 'off dudy',
      'end of shift', 'signed off', 'clocked out', 'going off duty',
      '10-7', '10/7', '10 7', 'ten seven', 'ten-seven', '107'
    ], 
    status: 'off duty',
    cadStatus: 'off_duty',
    isEmergency: false
  },
  { 
    phrases: [
      'out of service', 'outta service', 'out of svc', 'out of sirvice',
      'outofservice', 'out-of-service', 'out of service for now',
      'unavailable', 'not available', 'down', 'busy',
      '10-6', '10/6', '10 6', 'ten six', 'ten-six', '106'
    ], 
    status: 'out of service',
    cadStatus: 'out_of_service',
    isEmergency: false
  },
  { 
    phrases: [
      'clear', 'clear call', 'clear of call', 'clear the call',
      'i am clear', "i'm clear", 'im clear',
      'done', 'finished',
      '10-98', '10/98', '10 98', 'ten ninety eight', 'ten-ninety-eight', '1098'
    ], 
    status: 'clear',
    cadStatus: 'available',
    isEmergency: false
  }
];

const IMMEDIATE_COMMANDS = [
  {
    intent: 'RADIO_CHECK',
    phrases: ['radio check', 'how do you copy', 'copy check', 'radio test', 'comm check', 'comms check', 'communication check'],
    response: (unitId) => `${unitId}, loud and clear.`,
    isEmergency: false
  },
  {
    intent: 'TIME_CHECK',
    phrases: ['time check', 'whats the time', "what's the time", 'what time is it', 'current time', 'give me the time'],
    response: (unitId) => `${unitId}, time is ${formatTimestamp()}.`,
    isEmergency: false
  },
  {
    intent: 'REQUEST_BACKUP',
    phrases: ['need backup', 'requesting backup', 'send backup', 'need another unit', 'send another unit', 'request additional unit', 'need assistance', 'requesting assistance', '10-78', '10/78', 'ten seventy eight'],
    response: (unitId) => `${unitId}, copy backup request. Dispatching additional units.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `${unitId} requesting backup`, priority: 'high' }),
    isEmergency: true
  },
  {
    intent: 'EMERGENCY_BACKUP',
    phrases: ['officer needs assistance', 'officer down', 'shots fired', 'code 3 backup', 'emergency backup', '10-33', '10/33', 'ten thirty three'],
    response: (unitId) => `All units, ${unitId} emergency. All available units respond.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `EMERGENCY: ${unitId} needs immediate assistance`, priority: 'emergency' }),
    isEmergency: true
  },
  {
    intent: 'WELFARE_CHECK_COMPLETE',
    phrases: ['welfare check complete', 'subject is fine', 'welfare is good', 'subject ok', 'subject okay', 'welfare check good', 'no issues found'],
    response: (unitId) => `${unitId}, welfare check complete, ${formatTimestamp()}.`,
    cadAction: 'status',
    cadStatus: 'available',
    isEmergency: false
  },
  {
    intent: 'TRANSPORT',
    phrases: ['transporting', 'en route to hospital', 'heading to hospital', 'transporting to hospital', 'en route to er', 'heading to er', 'transporting one'],
    response: (unitId) => `${unitId}, copy transport. ${formatTimestamp()}.`,
    cadAction: 'status',
    cadStatus: 'en_route',
    isEmergency: false
  },
  {
    intent: 'AT_HOSPITAL',
    phrases: ['at hospital', 'arrived hospital', 'at the hospital', 'at er', 'arrived er', 'at the er', '10-85', '10/85'],
    response: (unitId) => `${unitId}, copy at hospital. ${formatTimestamp()}.`,
    cadAction: 'status',
    cadStatus: 'on_scene',
    isEmergency: false
  },
  {
    intent: 'CLEAR_HOSPITAL',
    phrases: ['clear hospital', 'leaving hospital', 'clear the hospital', 'available from hospital'],
    response: (unitId) => `${unitId}, clear hospital. ${formatTimestamp()}.`,
    cadAction: 'status',
    cadStatus: 'available',
    isEmergency: false
  },
  {
    intent: 'REQUEST_TOW',
    phrases: ['need a tow', 'requesting tow', 'need a wrecker', 'requesting wrecker', 'send a tow', 'send a wrecker', 'need tow truck'],
    response: (unitId) => `${unitId}, copy tow request. Wrecker dispatched.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `${unitId} requests tow truck`, priority: 'routine' }),
    isEmergency: false
  },
  {
    intent: 'REQUEST_SUPERVISOR',
    phrases: ['requesting supervisor', 'need a supervisor', 'send a supervisor', 'request supervisor', '10-25', '10/25', 'ten twenty five'],
    response: (unitId) => `${unitId}, copy supervisor request.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `${unitId} requests supervisor`, priority: 'routine' }),
    isEmergency: false
  },
  {
    intent: 'REQUEST_EMS',
    phrases: ['need ems', 'request ems', 'send ems', 'need an ambulance', 'requesting ambulance', 'need medic', 'request medic'],
    response: (unitId) => `${unitId}, copy EMS request. Dispatching.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `${unitId} requests EMS`, priority: 'high' }),
    isEmergency: true
  },
  {
    intent: 'REQUEST_FIRE',
    phrases: ['need fire', 'request fire', 'send fire', 'need fire department', 'requesting fire department'],
    response: (unitId) => `${unitId}, copy fire request. Dispatching.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `${unitId} requests fire department`, priority: 'high' }),
    isEmergency: true
  },
  {
    intent: 'REQUEST_K9',
    phrases: ['need k9', 'request k9', 'need canine', 'request canine', 'requesting k9 unit'],
    response: (unitId) => `${unitId}, copy K9 request.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `${unitId} requests K9 unit`, priority: 'routine' }),
    isEmergency: false
  },
  {
    intent: 'FOOT_PURSUIT',
    phrases: ['foot pursuit', 'on foot', 'subject running', 'in foot pursuit', 'pursuing on foot', '10-80 foot', '10/80 foot'],
    response: (unitId) => `All units, ${unitId} in foot pursuit. Additional units respond.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `${unitId} in FOOT PURSUIT`, priority: 'high' }),
    isEmergency: true
  },
  {
    intent: 'PURSUIT_TERMINATED',
    phrases: ['pursuit terminated', 'terminating pursuit', 'breaking off pursuit', 'ending pursuit', 'pursuit ended'],
    response: (unitId) => `${unitId}, copy pursuit terminated. ${formatTimestamp()}.`,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `${unitId} pursuit terminated`, priority: 'routine' }),
    isEmergency: false
  },
  {
    intent: 'SUBJECT_IN_CUSTODY',
    phrases: ['subject in custody', 'one in custody', 'suspect in custody', 'subject detained', '10-15', '10/15', 'ten fifteen', 'have one'],
    response: (unitId) => `${unitId}, copy one in custody. ${formatTimestamp()}.`,
    cadAction: 'status',
    cadStatus: 'on_scene',
    isEmergency: true
  },
  {
    intent: 'NEGATIVE_CONTACT',
    phrases: ['negative contact', 'no contact', 'unable to locate', 'utl', 'gone on arrival', 'goa', '10-91 negative', '10/91 negative'],
    response: (unitId) => `${unitId}, copy negative contact. ${formatTimestamp()}.`,
    isEmergency: false
  },
  {
    intent: 'REPEAT_LAST',
    phrases: ['say again', 'repeat', 'repeat that', 'did not copy', 'didnt copy', "didn't copy", '10-9', '10/9', 'ten nine'],
    response: (unitId) => `${unitId}, standby.`,
    isEmergency: false
  },
  {
    intent: 'ACKNOWLEDGED',
    phrases: ['10-4', '10/4', 'ten four', 'copy', 'copy that', 'roger', 'roger that', 'understood', 'received'],
    response: null,
    isEmergency: false
  },
  {
    intent: 'MEAL_BREAK',
    phrases: ['10-7 meal', '10/7 meal', 'out for meal', 'code 7', 'taking meal', 'meal break', 'lunch break'],
    response: (unitId) => `${unitId}, 10-7 meal. ${formatTimestamp()}.`,
    cadAction: 'status',
    cadStatus: 'out_of_service',
    isEmergency: false
  },
  {
    intent: 'RETURNING',
    phrases: ['returning to service', 'back from meal', 'returning from meal', 'returning'],
    response: (unitId) => `${unitId}, copy returning. ${formatTimestamp()}.`,
    cadAction: 'status',
    cadStatus: 'available',
    isEmergency: false
  },
  {
    intent: 'STANDBY',
    phrases: ['standing by', 'on standby', 'holding position', 'staging'],
    response: (unitId) => `${unitId}, copy standby.`,
    isEmergency: false
  }
];

const MULTI_STEP_COMMANDS = [
  {
    intent: 'TRAFFIC_STOP',
    phrases: ['traffic stop', 'traffic', 'out on a stop', 'vehicle stop', 'making a stop', '10-38', '10/38'],
    nextState: DISPATCHER_STATE.AWAITING_LOCATION,
    prompt: (unitId) => `${unitId}, go ahead with location.`,
    slotName: 'location',
    isEmergency: false,
    completion: (unitId, slots) => ({
      response: `${unitId}, copy traffic stop. ${slots.location}. ${formatTimestamp()}.`,
      cadAction: 'status',
      cadStatus: 'on_scene'
    })
  },
  {
    intent: 'RUN_PLATE',
    phrases: ['run a plate', 'run plate', 'plate check', 'registration check', 'run registration', 'check plate', 'run tag', 'check tag', '10-28', '10/28', 'ten twenty eight'],
    nextState: DISPATCHER_STATE.AWAITING_PLATE,
    prompt: (unitId) => `${unitId}, go ahead with plate.`,
    slotName: 'plate',
    isEmergency: false,
    completion: async (unitId, slots, cadService) => {
      if (cadService) {
        const result = await cadService.queryVehicle(slots.plate, slots.state || 'PA');
        if (result.success && result.vehicle) {
          const v = result.vehicle;
          return {
            response: `${unitId}, plate returns to ${v.year || ''} ${v.color || ''} ${v.make || ''} ${v.model || ''}. Registered to ${v.owner_name || 'unknown'}. ${v.status === 'valid' ? 'Valid registration.' : 'Registration ' + (v.status || 'status unknown') + '.'}`,
            cadAction: null
          };
        } else {
          return {
            response: `${unitId}, no return on that plate.`,
            cadAction: null
          };
        }
      }
      return {
        response: `${unitId}, plate ${slots.plate}, standby for return.`,
        cadAction: null
      };
    }
  },
  {
    intent: 'WARRANT_CHECK',
    phrases: ['warrant check', 'check for warrants', 'wants and warrants', 'run a name', 'check name', '10-29', '10/29', 'ten twenty nine'],
    nextState: DISPATCHER_STATE.AWAITING_NAME,
    prompt: (unitId) => `${unitId}, go ahead with name.`,
    slotName: 'name',
    isEmergency: false,
    completion: async (unitId, slots, cadService) => {
      if (cadService && slots.firstName && slots.lastName) {
        const result = await cadService.queryWarrant(slots.firstName, slots.lastName);
        if (result.success) {
          if (result.warrants && result.warrants.length > 0) {
            return {
              response: `${unitId}, subject shows ${result.warrants.length} active warrant${result.warrants.length > 1 ? 's' : ''}. Use caution.`,
              cadAction: null
            };
          } else {
            return {
              response: `${unitId}, negative warrants on file.`,
              cadAction: null
            };
          }
        }
      }
      return {
        response: `${unitId}, standby for warrant check.`,
        cadAction: null
      };
    }
  },
  {
    intent: 'BOLO',
    phrases: ['bolo', 'be on the lookout', 'put out a bolo', 'broadcast bolo'],
    nextState: DISPATCHER_STATE.AWAITING_DESCRIPTION,
    prompt: (unitId) => `${unitId}, go ahead with description.`,
    slotName: 'description',
    isEmergency: true,
    completion: (unitId, slots) => ({
      response: `All units, BOLO from ${unitId}. ${slots.description}. ${formatTimestamp()}.`,
      cadAction: 'broadcast',
      cadData: { message: `BOLO: ${slots.description}`, priority: 'high' }
    })
  },
  {
    intent: 'VEHICLE_PURSUIT',
    phrases: ['vehicle pursuit', 'in pursuit', 'starting pursuit', '10-80', '10/80', 'ten eighty'],
    nextState: DISPATCHER_STATE.AWAITING_DESCRIPTION,
    prompt: (unitId) => `${unitId}, go ahead with vehicle and direction.`,
    slotName: 'description',
    isEmergency: true,
    completion: (unitId, slots) => ({
      response: `All units, ${unitId} in vehicle pursuit. ${slots.description}. All units clear the channel.`,
      cadAction: 'broadcast',
      cadData: { message: `VEHICLE PURSUIT: ${unitId} - ${slots.description}`, priority: 'emergency' }
    })
  },
  {
    intent: 'PERSON_CHECK',
    phrases: [
      '10-27', '10/27', 'ten twenty seven', 'ten-twenty-seven', '1027',
      'records check', 'record check', 'check one by name', 'check by name',
      'can you search', 'search by name', 'search someone', 'run a subject',
      'name and dob', 'name and date of birth', 'subject check'
    ],
    nextState: DISPATCHER_STATE.AWAITING_PERSON_DETAILS,
    prompt: (unitId) => `${unitId}, 10-27 go ahead.`,
    slotName: 'personDetails',
    isEmergency: false,
    requiresSecureCheck: true
  }
];

const EMERGENCY_COMMANDS = [
  {
    intent: 'SIGNAL_100',
    phrases: ['signal 100', 'signal one hundred', 'emergency traffic only', 'clear the air', 'clear channel'],
    response: (unitId) => `All units, signal 100. Emergency traffic only. ${formatTimestamp()}.`,
    activateSignal100: true,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `SIGNAL 100 ACTIVATED by ${unitId}`, priority: 'emergency' })
  },
  {
    intent: 'SIGNAL_100_CLEAR',
    phrases: ['signal 100 clear', 'clear signal 100', 'resume normal traffic', 'normal traffic'],
    response: (unitId) => `All units, signal 100 clear. Resume normal traffic. ${formatTimestamp()}.`,
    clearSignal100: true,
    cadAction: 'broadcast',
    cadData: (unitId) => ({ message: `Signal 100 cleared by ${unitId}`, priority: 'routine' })
  }
];

const CANCEL_PHRASES = ['cancel', 'never mind', 'nevermind', 'disregard', 'negative', 'scratch that'];

const DETAIL_COMMAND_PATTERNS = [
  { regex: /(?:show\s+me\s+out\s+on\s+(?:a\s+)?detail\s+at|out\s+on\s+(?:a\s+)?detail\s+at|on\s+(?:a\s+)?detail\s+at|detail\s+at)\s+(.+)/i, hasLocation: true },
  { regex: /(?:show\s+me\s+out\s+on\s+(?:a\s+)?detail|out\s+on\s+(?:a\s+)?detail|on\s+(?:a\s+)?detail)\b/i, hasLocation: false },
];

function matchDetailCommand(transcript) {
  for (const pattern of DETAIL_COMMAND_PATTERNS) {
    const match = transcript.match(pattern.regex);
    if (match) {
      const location = pattern.hasLocation && match[1] ? match[1].trim() : null;
      return { location };
    }
  }
  return null;
}

const ZONE_CHANGE_PATTERNS = [
  { regex: /(?:change\s+(?:my\s+)?zone\s+to|zone\s+change\s+to)\s+(.+)/i, hasZone: true },
  { regex: /(?:show\s+me\s+out\s+at|out\s+at)\s+(.+)/i, hasZone: true },
  { regex: /(?:relocating\s+to|moving\s+to(?:\s+zone)?)\s+(.+)/i, hasZone: true },
  { regex: /(?:change\s+(?:my\s+)?zone|zone\s+change)/i, hasZone: false },
  { regex: /(?:show\s+me\s+out)\b/i, hasZone: false },
];

function matchZoneChange(transcript) {
  for (const pattern of ZONE_CHANGE_PATTERNS) {
    const match = transcript.match(pattern.regex);
    if (match) {
      const zone = pattern.hasZone && match[1] ? match[1].trim() : null;
      return { zone };
    }
  }
  return null;
}

const SECURE_CONFIRM_PHRASES = [
  'yes', 'yeah', 'yep', 'affirmative', 'secure', 'go ahead',
  '10-4', '10/4', 'ten four', 'ten-four', 'copy', 'roger'
];

const SECURE_DENY_PHRASES = [
  'no', 'negative', 'not secure', 'standby', 'hold'
];

const EMERGENCY_OK_PHRASES = [
  '10-4', '10/4', 'ten four', 'ten-four',
  "i'm 10-4", "i'm 10/4", 'im 10-4', 'im 10/4', "i am 10-4", "i am 10/4",
  "i'm okay", 'im okay', "i am okay",
  "i'm ok", 'im ok', "i am ok",
  "i'm fine", 'im fine', "i am fine",
  "i'm good", 'im good', "i am good",
  'all good', 'all clear', 'code 4', 'code four'
];

const EMERGENCY_DISTRESS_PHRASES = [
  { phrase: 'needs assistance', distressType: 'requesting assistance' },
  { phrase: 'need assistance', distressType: 'requesting assistance' },
  { phrase: 'requesting assistance', distressType: 'requesting assistance' },
  { phrase: 'need backup', distressType: 'requesting backup' },
  { phrase: 'needs backup', distressType: 'requesting backup' },
  { phrase: 'requesting backup', distressType: 'requesting backup' },
  { phrase: 'shots fired', distressType: 'reporting shots fired' },
  { phrase: 'shot fired', distressType: 'reporting shots fired' },
  { phrase: 'officer down', distressType: 'reporting officer down' },
  { phrase: 'officer needs help', distressType: 'requesting emergency backup' },
  { phrase: 'under fire', distressType: 'under fire' },
  { phrase: 'taking fire', distressType: 'taking fire' },
  { phrase: 'hostile', distressType: 'reporting hostile subject' },
  { phrase: 'weapon', distressType: 'reporting armed subject' },
  { phrase: 'armed subject', distressType: 'reporting armed subject' },
  { phrase: 'help', distressType: 'requesting immediate assistance' },
  { phrase: 'ambush', distressType: 'reporting ambush' }
];

let signal100Active = false;
let signal100Unit = null;
let signal100Timeout = null;

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTimestamp() {
  const options = {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(new Date());
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  return `${hour}:${minute} hours`;
}

function containsWakePhrase(transcript) {
  const normalized = normalizeText(transcript);
  return normalized.includes('central');
}

function containsCancelPhrase(transcript) {
  const normalized = normalizeText(transcript);
  return CANCEL_PHRASES.some(phrase => normalized.includes(phrase));
}

export function matchEmergencyResponse(transcript) {
  const normalized = normalizeText(transcript);
  
  for (const phrase of EMERGENCY_OK_PHRASES) {
    if (normalized.includes(phrase)) {
      return { type: 'OK' };
    }
  }
  
  for (const distress of EMERGENCY_DISTRESS_PHRASES) {
    if (normalized.includes(distress.phrase)) {
      return { type: 'DISTRESS', distressType: distress.distressType };
    }
  }
  
  return null;
}

export function matchSecureConfirmation(transcript) {
  const normalized = normalizeText(transcript);
  
  for (const phrase of SECURE_CONFIRM_PHRASES) {
    if (normalized.includes(phrase)) {
      return { confirmed: true };
    }
  }
  
  for (const phrase of SECURE_DENY_PHRASES) {
    if (normalized.includes(phrase)) {
      return { confirmed: false };
    }
  }
  
  return null;
}

export function getUnitSessionState(unitId) {
  const session = getUnitSession(unitId);
  return {
    state: session.state,
    pendingIntent: session.pendingIntent,
    slots: session.slots
  };
}

export function setUnitSessionState(unitId, state, pendingIntent = null, slots = {}) {
  const session = getUnitSession(unitId);
  session.state = state;
  session.pendingIntent = pendingIntent;
  session.slots = { ...session.slots, ...slots };
  session.lastActivity = Date.now();
  startSessionTimeout(unitId);
}

export { DISPATCHER_STATE };

function extractPlate(transcript) {
  const normalized = normalizeText(transcript);
  const platePatterns = [
    /([a-z]{3})\s*(\d{4})/i,
    /([a-z]{2})\s*(\d{4})/i,
    /(\d{3})\s*([a-z]{3,4})/i,
    /([a-z0-9]{5,8})/i
  ];
  
  for (const pattern of platePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      return match[0].replace(/\s/g, '').toUpperCase();
    }
  }
  
  const words = normalized.split(' ');
  const alphaNumeric = words.filter(w => /^[a-z0-9]+$/i.test(w) && w.length >= 2);
  if (alphaNumeric.length > 0) {
    return alphaNumeric.join('').toUpperCase().slice(0, 8);
  }
  
  return null;
}

function extractName(transcript) {
  const normalized = normalizeText(transcript);
  const words = normalized.split(' ').filter(w => w.length > 1 && !/^(the|a|an|and|or|for|on|at|to|is|last|first|name|middle)$/i.test(w));
  
  if (words.length >= 2) {
    return {
      firstName: words[0].charAt(0).toUpperCase() + words[0].slice(1),
      lastName: words[words.length - 1].charAt(0).toUpperCase() + words[words.length - 1].slice(1)
    };
  } else if (words.length === 1) {
    return {
      firstName: null,
      lastName: words[0].charAt(0).toUpperCase() + words[0].slice(1)
    };
  }
  
  return null;
}

function matchStatusCommand(transcript) {
  const normalized = normalizeText(transcript);
  
  for (const cmd of STATUS_COMMANDS) {
    for (const phrase of cmd.phrases) {
      if (normalized.includes(phrase) || normalized === phrase) {
        return { status: cmd.status, cadStatus: cmd.cadStatus, isEmergency: cmd.isEmergency };
      }
    }
  }
  return null;
}

function matchImmediateCommand(transcript) {
  const normalized = normalizeText(transcript);
  
  for (const cmd of IMMEDIATE_COMMANDS) {
    for (const phrase of cmd.phrases) {
      if (normalized.includes(phrase)) {
        return cmd;
      }
    }
  }
  return null;
}

function matchMultiStepCommand(transcript) {
  const normalized = normalizeText(transcript);
  
  for (const cmd of MULTI_STEP_COMMANDS) {
    for (const phrase of cmd.phrases) {
      if (normalized.includes(phrase)) {
        return cmd;
      }
    }
  }
  return null;
}

function matchEmergencyCommand(transcript) {
  const normalized = normalizeText(transcript);
  
  for (const cmd of EMERGENCY_COMMANDS) {
    for (const phrase of cmd.phrases) {
      if (normalized.includes(phrase)) {
        return cmd;
      }
    }
  }
  return null;
}

export function matchCommand(transcript, participantId = null) {
  if (!transcript || typeof transcript !== 'string') {
    return null;
  }

  const unitId = participantId || 'Unknown Unit';
  const session = getUnitSession(unitId);
  const normalized = normalizeText(transcript);
  
  console.log(`[CommandMatcher] Unit: ${unitId}, State: ${session.state}, Transcript: "${transcript}"`);

  const confirmStates = [
    DISPATCHER_STATE.AWAITING_PERSON_CONFIRM,
    DISPATCHER_STATE.AWAITING_SECURE_CONFIRM,
    DISPATCHER_STATE.AWAITING_ZONE_CONFIRM,
    DISPATCHER_STATE.AWAITING_DETAIL_CONFIRM
  ];
  if (containsCancelPhrase(transcript) && !confirmStates.includes(session.state)) {
    resetUnitSession(unitId);
    return null;
  }

  if (signal100Active) {
    const emergencyCmd = matchEmergencyCommand(transcript);
    if (emergencyCmd) {
      if (emergencyCmd.clearSignal100) {
        signal100Active = false;
        signal100Unit = null;
        if (signal100Timeout) clearTimeout(signal100Timeout);
        resetUnitSession(unitId);
        return {
          response: emergencyCmd.response(unitId),
          unitId,
          cadStatus: null,
          cadAction: emergencyCmd.cadAction,
          cadData: typeof emergencyCmd.cadData === 'function' ? emergencyCmd.cadData(unitId) : emergencyCmd.cadData
        };
      }
      return {
        response: emergencyCmd.response(unitId),
        unitId,
        cadStatus: null,
        cadAction: emergencyCmd.cadAction,
        cadData: typeof emergencyCmd.cadData === 'function' ? emergencyCmd.cadData(unitId) : emergencyCmd.cadData
      };
    }
    
    const immediateCmd = matchImmediateCommand(transcript);
    const multiStepCmd = matchMultiStepCommand(transcript);
    const statusCmd = matchStatusCommand(transcript);
    
    const isEmergencyIntent = (immediateCmd && immediateCmd.isEmergency) || 
                              (multiStepCmd && multiStepCmd.isEmergency) ||
                              (statusCmd && statusCmd.isEmergency);
    
    if (!isEmergencyIntent && containsWakePhrase(transcript)) {
      return {
        response: `${unitId}, signal 100 in effect. Emergency traffic only.`,
        unitId,
        cadStatus: null
      };
    }
    
    if (!isEmergencyIntent) {
      return null;
    }
  }

  if (session.state === DISPATCHER_STATE.AWAITING_PLATE) {
    const plate = extractPlate(transcript);
    if (plate) {
      session.slots.plate = plate;
      const cmd = session.pendingIntent;
      resetUnitSession(unitId);
      
      if (cmd && cmd.completion) {
        return {
          response: null,
          unitId,
          cadStatus: null,
          asyncCompletion: async (cadService) => {
            const result = await cmd.completion(unitId, { plate }, cadService);
            return result;
          }
        };
      }
    }
    return null;
  }

  if (session.state === DISPATCHER_STATE.AWAITING_NAME) {
    const name = extractName(transcript);
    if (name) {
      session.slots = { ...session.slots, ...name };
      const cmd = session.pendingIntent;
      resetUnitSession(unitId);
      
      if (cmd && cmd.completion) {
        return {
          response: null,
          unitId,
          cadStatus: null,
          asyncCompletion: async (cadService) => {
            const result = await cmd.completion(unitId, { ...name }, cadService);
            return result;
          }
        };
      }
    }
    return null;
  }

  if (session.state === DISPATCHER_STATE.AWAITING_LOCATION || 
      session.state === DISPATCHER_STATE.AWAITING_DESCRIPTION) {
    const slotValue = transcript.trim();
    if (slotValue.length > 2) {
      const cmd = session.pendingIntent;
      session.slots[cmd.slotName] = slotValue;
      resetUnitSession(unitId);
      
      if (cmd && cmd.completion) {
        const result = typeof cmd.completion === 'function' 
          ? cmd.completion(unitId, session.slots)
          : cmd.completion;
        return {
          response: result.response,
          unitId,
          cadStatus: result.cadStatus || null,
          cadAction: result.cadAction || null,
          cadData: result.cadData || null
        };
      }
    }
    return null;
  }

  if (session.state === DISPATCHER_STATE.AWAITING_PERSON_DETAILS) {
    return {
      response: null,
      unitId,
      intent: 'PERSON_CHECK_DETAILS',
      rawTranscript: transcript,
      pendingIntent: session.pendingIntent
    };
  }

  if (session.state === DISPATCHER_STATE.AWAITING_PERSON_DOB) {
    return {
      response: null,
      unitId,
      intent: 'PERSON_CHECK_DOB',
      rawTranscript: transcript,
      slots: session.slots
    };
  }

  if (session.state === DISPATCHER_STATE.AWAITING_PERSON_CONFIRM) {
    return {
      response: null,
      unitId,
      intent: 'PERSON_CHECK_CONFIRM',
      rawTranscript: transcript,
      slots: session.slots
    };
  }

  if (session.state === DISPATCHER_STATE.AWAITING_PERSON_FIRSTNAME) {
    return {
      response: null,
      unitId,
      intent: 'PERSON_CHECK_FIRSTNAME',
      rawTranscript: transcript,
      slots: session.slots
    };
  }

  if (session.state === DISPATCHER_STATE.AWAITING_ZONE) {
    return {
      response: null,
      unitId,
      intent: 'ZONE_DETAILS',
      rawTranscript: transcript,
      slots: session.slots
    };
  }

  if (session.state === DISPATCHER_STATE.AWAITING_ZONE_CONFIRM) {
    return {
      response: null,
      unitId,
      intent: 'ZONE_CONFIRM',
      rawTranscript: transcript,
      slots: session.slots
    };
  }

  if (session.state === DISPATCHER_STATE.AWAITING_DETAIL_LOCATION) {
    return {
      response: null,
      unitId,
      intent: 'DETAIL_LOCATION',
      rawTranscript: transcript,
      slots: session.slots
    };
  }

  if (session.state === DISPATCHER_STATE.AWAITING_DETAIL_CONFIRM) {
    return {
      response: null,
      unitId,
      intent: 'DETAIL_CONFIRM',
      rawTranscript: transcript,
      slots: session.slots
    };
  }

  if (session.state === DISPATCHER_STATE.AWAITING_SECURE_CONFIRM) {
    return {
      response: null,
      unitId,
      intent: 'SECURE_CONFIRM_RESPONSE',
      rawTranscript: transcript,
      slots: session.slots
    };
  }

  if (session.state === DISPATCHER_STATE.IDLE) {
    if (containsWakePhrase(transcript)) {
      const emergencyCmd = matchEmergencyCommand(transcript);
      if (emergencyCmd) {
        if (emergencyCmd.activateSignal100) {
          signal100Active = true;
          signal100Unit = unitId;
          if (signal100Timeout) clearTimeout(signal100Timeout);
          signal100Timeout = setTimeout(() => {
            signal100Active = false;
            signal100Unit = null;
          }, SIGNAL_100_TIMEOUT_MS);
        }
        if (emergencyCmd.clearSignal100) {
          signal100Active = false;
          signal100Unit = null;
          if (signal100Timeout) clearTimeout(signal100Timeout);
        }
        
        return {
          response: emergencyCmd.response(unitId),
          unitId,
          cadStatus: null,
          cadAction: emergencyCmd.cadAction,
          cadData: typeof emergencyCmd.cadData === 'function' ? emergencyCmd.cadData(unitId) : emergencyCmd.cadData
        };
      }

      const detailResult = matchDetailCommand(transcript);
      if (detailResult) {
        if (detailResult.location) {
          session.state = DISPATCHER_STATE.AWAITING_DETAIL_CONFIRM;
          session.slots = { location: detailResult.location };
          startSessionTimeout(unitId);
          return {
            response: null,
            unitId,
            intent: 'DETAIL_WITH_LOCATION',
            rawTranscript: transcript,
            slots: { location: detailResult.location }
          };
        } else {
          session.state = DISPATCHER_STATE.AWAITING_DETAIL_LOCATION;
          session.slots = {};
          startSessionTimeout(unitId);
          return {
            response: `${unitId}, go ahead with location.`,
            unitId,
            cadStatus: null
          };
        }
      }

      const zoneResult = matchZoneChange(transcript);
      if (zoneResult) {
        if (zoneResult.zone) {
          session.state = DISPATCHER_STATE.AWAITING_ZONE_CONFIRM;
          session.slots = { zone: zoneResult.zone };
          startSessionTimeout(unitId);
          return {
            response: null,
            unitId,
            intent: 'ZONE_DETAILS_WITH_ZONE',
            rawTranscript: transcript,
            slots: { zone: zoneResult.zone }
          };
        } else {
          session.state = DISPATCHER_STATE.AWAITING_ZONE;
          session.slots = {};
          startSessionTimeout(unitId);
          return {
            response: `${unitId}, go ahead with zone.`,
            unitId,
            cadStatus: null
          };
        }
      }

      const statusResult = matchStatusCommand(transcript);
      if (statusResult) {
        return {
          response: `${unitId}, ${statusResult.status}, ${formatTimestamp()}.`,
          unitId,
          cadStatus: statusResult.cadStatus
        };
      }

      const immediateCmd = matchImmediateCommand(transcript);
      if (immediateCmd) {
        if (immediateCmd.response === null) {
          return null;
        }
        return {
          response: immediateCmd.response(unitId),
          unitId,
          cadStatus: immediateCmd.cadStatus || null,
          cadAction: immediateCmd.cadAction || null,
          cadData: typeof immediateCmd.cadData === 'function' ? immediateCmd.cadData(unitId) : immediateCmd.cadData
        };
      }

      const multiStepCmd = matchMultiStepCommand(transcript);
      if (multiStepCmd) {
        session.state = multiStepCmd.nextState;
        session.pendingIntent = multiStepCmd;
        session.slots = {};
        startSessionTimeout(unitId);
        
        return {
          response: multiStepCmd.prompt(unitId),
          unitId,
          cadStatus: null
        };
      }

      session.state = DISPATCHER_STATE.AWAITING_COMMAND;
      startSessionTimeout(unitId);
      return { response: `${unitId}, go ahead.`, unitId, cadStatus: null };
    }
    return null;
  }

  if (session.state === DISPATCHER_STATE.AWAITING_COMMAND) {
    if (containsWakePhrase(transcript)) {
      startSessionTimeout(unitId);
      return { response: `${unitId}, go ahead.`, unitId, cadStatus: null };
    }

    const emergencyCmd = matchEmergencyCommand(transcript);
    if (emergencyCmd) {
      if (emergencyCmd.activateSignal100) {
        signal100Active = true;
        signal100Unit = unitId;
        if (signal100Timeout) clearTimeout(signal100Timeout);
        signal100Timeout = setTimeout(() => {
          signal100Active = false;
          signal100Unit = null;
        }, SIGNAL_100_TIMEOUT_MS);
      }
      if (emergencyCmd.clearSignal100) {
        signal100Active = false;
        signal100Unit = null;
        if (signal100Timeout) clearTimeout(signal100Timeout);
      }
      resetUnitSession(unitId);
      
      return {
        response: emergencyCmd.response(unitId),
        unitId,
        cadStatus: null,
        cadAction: emergencyCmd.cadAction,
        cadData: typeof emergencyCmd.cadData === 'function' ? emergencyCmd.cadData(unitId) : emergencyCmd.cadData
      };
    }

    const detailResult2 = matchDetailCommand(transcript);
    if (detailResult2) {
      if (detailResult2.location) {
        session.state = DISPATCHER_STATE.AWAITING_DETAIL_CONFIRM;
        session.slots = { location: detailResult2.location };
        startSessionTimeout(unitId);
        return {
          response: null,
          unitId,
          intent: 'DETAIL_WITH_LOCATION',
          rawTranscript: transcript,
          slots: { location: detailResult2.location }
        };
      } else {
        session.state = DISPATCHER_STATE.AWAITING_DETAIL_LOCATION;
        session.slots = {};
        startSessionTimeout(unitId);
        return {
          response: `${unitId}, go ahead with location.`,
          unitId,
          cadStatus: null
        };
      }
    }

    const zoneResult2 = matchZoneChange(transcript);
    if (zoneResult2) {
      if (zoneResult2.zone) {
        session.state = DISPATCHER_STATE.AWAITING_ZONE_CONFIRM;
        session.slots = { zone: zoneResult2.zone };
        startSessionTimeout(unitId);
        return {
          response: null,
          unitId,
          intent: 'ZONE_DETAILS_WITH_ZONE',
          rawTranscript: transcript,
          slots: { zone: zoneResult2.zone }
        };
      } else {
        session.state = DISPATCHER_STATE.AWAITING_ZONE;
        session.slots = {};
        startSessionTimeout(unitId);
        return {
          response: `${unitId}, go ahead with zone.`,
          unitId,
          cadStatus: null
        };
      }
    }

    const statusResult = matchStatusCommand(transcript);
    if (statusResult) {
      resetUnitSession(unitId);
      return {
        response: `${unitId}, ${statusResult.status}, ${formatTimestamp()}.`,
        unitId,
        cadStatus: statusResult.cadStatus
      };
    }

    const immediateCmd = matchImmediateCommand(transcript);
    if (immediateCmd) {
      resetUnitSession(unitId);
      if (immediateCmd.response === null) {
        return null;
      }
      return {
        response: immediateCmd.response(unitId),
        unitId,
        cadStatus: immediateCmd.cadStatus || null,
        cadAction: immediateCmd.cadAction || null,
        cadData: typeof immediateCmd.cadData === 'function' ? immediateCmd.cadData(unitId) : immediateCmd.cadData
      };
    }

    const multiStepCmd = matchMultiStepCommand(transcript);
    if (multiStepCmd) {
      session.state = multiStepCmd.nextState;
      session.pendingIntent = multiStepCmd;
      session.slots = {};
      startSessionTimeout(unitId);
      
      return {
        response: multiStepCmd.prompt(unitId),
        unitId,
        cadStatus: null
      };
    }

    return null;
  }

  return null;
}

export function resetDispatcherState() {
  unitSessions.clear();
  signal100Active = false;
  signal100Unit = null;
  if (signal100Timeout) {
    clearTimeout(signal100Timeout);
    signal100Timeout = null;
  }
}

export function getDispatcherState() {
  return {
    sessions: Object.fromEntries(unitSessions),
    signal100Active,
    signal100Unit
  };
}

export function isSignal100Active() {
  return signal100Active;
}

export function getCommandTable() {
  const commands = [];
  
  STATUS_COMMANDS.forEach(c => {
    commands.push({ category: 'Status', phrase: c.phrases[0], description: c.status });
  });
  
  IMMEDIATE_COMMANDS.forEach(c => {
    if (c.response) {
      commands.push({ category: 'Immediate', phrase: c.phrases[0], description: c.intent });
    }
  });
  
  MULTI_STEP_COMMANDS.forEach(c => {
    commands.push({ category: 'Multi-Step', phrase: c.phrases[0], description: c.intent });
  });
  
  EMERGENCY_COMMANDS.forEach(c => {
    commands.push({ category: 'Emergency', phrase: c.phrases[0], description: c.intent });
  });
  
  return commands;
}
