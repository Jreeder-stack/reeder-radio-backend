const DISPATCHER_STATE = {
  IDLE: 'IDLE',
  AWAITING_STATUS: 'AWAITING_STATUS'
};

const STATUS_COMMANDS = [
  { 
    phrases: [
      'on duty', 'on-duty', 'onduty', 'on doody', 'on dudy', 'on duety',
      'in service', 'signed on', 'clocked in', 'starting shift',
      '10-8', '10 8', 'ten eight', 'ten-eight'
    ], 
    status: 'on duty' 
  },
  { 
    phrases: [
      'available', 'avail', 'a vailable', 'clear and available',
      'back in service', 'ready', 'free',
      '10-8 available', 'ten eight available'
    ], 
    status: 'available' 
  },
  { 
    phrases: [
      'en route', 'enroute', 'on route', 'in route', 'inroute', 'in rout',
      'on my way', 'heading that way', 'rolling',
      '10-76', '10 76', 'ten seventy six', 'ten-seventy-six', '1076'
    ], 
    status: 'en route' 
  },
  { 
    phrases: [
      'on scene', 'on seen', 'onscene', 'on-scene', 'on scn', 'on sene', 'at scene',
      'on location', 'onlocation', 'on-location', 'at location', 'arrived',
      '10-97', '10 97', 'ten ninety seven', 'ten-ninety-seven', '1097'
    ], 
    status: 'on scene' 
  },
  { 
    phrases: [
      'off duty', 'off-duty', 'offduty', 'off doody', 'off dudy',
      'end of shift', 'signed off', 'clocked out', 'going off duty',
      '10-7', '10 7', 'ten seven', 'ten-seven', '107'
    ], 
    status: 'off duty' 
  },
  { 
    phrases: [
      'out of service', 'outta service', 'out of svc', 'out of sirvice',
      'outofservice', 'out-of-service', 'out of service for now',
      'unavailable', 'not available', 'down', 'busy',
      '10-6', '10 6', 'ten six', 'ten-six', '106'
    ], 
    status: 'out of service' 
  },
  { 
    phrases: [
      'clear', 'clear call', 'clear of call', 'clear the call',
      'i am clear', "i'm clear", 'im clear',
      'done', 'finished',
      '10-98', '10 98', 'ten ninety eight', 'ten-ninety-eight', '1098'
    ], 
    status: 'clear' 
  }
];

let currentState = DISPATCHER_STATE.IDLE;
let currentUnitId = null;
let stateTimeout = null;

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
  return `${hour}${minute} hours`;
}

function containsWakePhrase(transcript) {
  const normalized = normalizeText(transcript);
  return normalized.includes('central');
}

const CANCEL_PHRASES = ['cancel', 'never mind', 'nevermind', 'disregard'];

function containsCancelPhrase(transcript) {
  const normalized = normalizeText(transcript);
  return CANCEL_PHRASES.some(phrase => normalized.includes(phrase));
}

function matchStatusCommand(transcript) {
  const normalized = normalizeText(transcript);
  
  if (containsCancelPhrase(normalized)) {
    return 'CANCEL';
  }
  
  for (const cmd of STATUS_COMMANDS) {
    for (const phrase of cmd.phrases) {
      if (normalized.includes(phrase) || normalized === phrase) {
        return cmd.status;
      }
    }
  }
  return null;
}

function resetState() {
  currentState = DISPATCHER_STATE.IDLE;
  currentUnitId = null;
  if (stateTimeout) {
    clearTimeout(stateTimeout);
    stateTimeout = null;
  }
}

function startStateTimeout() {
  if (stateTimeout) {
    clearTimeout(stateTimeout);
  }
  stateTimeout = setTimeout(() => {
    resetState();
  }, 30000);
}

export function matchCommand(transcript, participantId = null) {
  if (!transcript || typeof transcript !== 'string') {
    return null;
  }

  if (currentState === DISPATCHER_STATE.IDLE) {
    if (containsWakePhrase(transcript)) {
      currentUnitId = participantId || 'Unknown Unit';
      currentState = DISPATCHER_STATE.AWAITING_STATUS;
      startStateTimeout();
      return `${currentUnitId}, go ahead.`;
    }
    return null;
  }

  if (currentState === DISPATCHER_STATE.AWAITING_STATUS) {
    if (containsWakePhrase(transcript)) {
      currentUnitId = participantId || 'Unknown Unit';
      startStateTimeout();
      return `${currentUnitId}, go ahead.`;
    }
    
    const status = matchStatusCommand(transcript);
    if (status === 'CANCEL') {
      resetState();
      return null;
    }
    if (status) {
      const unitId = currentUnitId;
      const timestamp = formatTimestamp();
      resetState();
      return `${unitId}, ${status}, ${timestamp}.`;
    }
    return null;
  }

  return null;
}

export function resetDispatcherState() {
  resetState();
}

export function getDispatcherState() {
  return {
    state: currentState,
    unitId: currentUnitId
  };
}

export function getCommandTable() {
  return STATUS_COMMANDS.map(c => ({
    phrase: c.phrases[0],
    response: c.status
  }));
}
