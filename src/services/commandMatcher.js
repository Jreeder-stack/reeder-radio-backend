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
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}${minutes} hours`;
}

function parseWakePhrase(transcript) {
  const normalized = normalizeText(transcript);
  const wakePattern = /^central[,\s]+(.+)$/;
  const match = normalized.match(wakePattern);
  
  if (match && match[1]) {
    const unitId = match[1].trim();
    if (unitId && unitId.length > 0) {
      return unitId;
    }
  }
  return null;
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
  }, 15000);
}

export function matchCommand(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return null;
  }

  if (currentState === DISPATCHER_STATE.IDLE) {
    const unitId = parseWakePhrase(transcript);
    if (unitId) {
      currentUnitId = unitId;
      currentState = DISPATCHER_STATE.AWAITING_STATUS;
      startStateTimeout();
      return `${unitId}, go ahead.`;
    }
    return null;
  }

  if (currentState === DISPATCHER_STATE.AWAITING_STATUS) {
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
