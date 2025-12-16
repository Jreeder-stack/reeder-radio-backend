const DISPATCHER_STATE = {
  IDLE: 'IDLE',
  AWAITING_STATUS: 'AWAITING_STATUS'
};

const STATUS_COMMANDS = [
  { phrases: ['on duty', 'on-duty', 'onduty'], status: 'on duty' },
  { phrases: ['en route', 'enroute', 'in route', 'inroute'], status: 'en route' },
  { phrases: ['on scene', 'onscene', 'on-scene'], status: 'on scene' },
  { phrases: ['on location', 'onlocation', 'on-location'], status: 'on location' },
  { phrases: ['available'], status: 'available' },
  { phrases: ['off duty', 'off-duty', 'offduty'], status: 'off duty' },
  { phrases: ['out of service', 'outofservice', 'out-of-service'], status: 'out of service' },
  { phrases: ['clear', 'i am clear', "i'm clear", 'im clear'], status: 'clear' }
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

function matchStatusCommand(transcript) {
  const normalized = normalizeText(transcript);
  
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
