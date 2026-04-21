const UNIT_TOKEN = '(?:[a-z]+[\\s-]?\\d{1,3}|\\d{4})';

const EMERGENCY_BYPASS_PATTERNS = [
  { phrase: 'shots fired', rx: /\bshots?\s+fired\b/i },
  { phrase: 'gunpoint', rx: /\bgun\s*point\b/i },
  { phrase: 'taser point', rx: /\btaser\s*point\b/i },
  { phrase: 'taser deployed', rx: /\btaser\s+deployed\b/i },
  { phrase: 'foot pursuit', rx: /\bfoot\s+pursuit\b/i },
  { phrase: 'vehicle pursuit', rx: /\bvehicle\s+pursuit\b/i },
  { phrase: 'in pursuit', rx: /\bin\s+pursuit\b/i },
  { phrase: 'pursuit', rx: /\bpursuit\b/i },
  { phrase: 'fight in progress', rx: /\bfight\s+in\s+progress\b/i },
  { phrase: 'fighting', rx: /\bfighting\b/i },
  { phrase: 'officer down', rx: /\bofficer\s+down\b/i },
  { phrase: '10-33', rx: /\b10[-\s/]?33\b/i },
  { phrase: 'ten thirty three', rx: /\bten\s+thirty[-\s]?three\b/i },
  { phrase: 'subject with a weapon', rx: /\bsubject\s+with\s+a\s+weapon\b/i },
  { phrase: 'hostage', rx: /\bhostage\b/i },
];

const SEND_ME_ANOTHER_RX = /\bsend\s+me\s+another\b/i;

function normalize(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[.,!?]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeUnitId(s) {
  if (!s) return null;
  return String(s).trim().toUpperCase().replace(/\s+/g, '-');
}

export function detectEmergencyBypass(transcript, { hasActiveEscalation = false } = {}) {
  if (!transcript) return null;
  for (const { phrase, rx } of EMERGENCY_BYPASS_PATTERNS) {
    if (rx.test(transcript)) {
      return { phrase };
    }
  }
  if (SEND_ME_ANOTHER_RX.test(transcript)) {
    return { phrase: 'send me another' };
  }
  return null;
}

export const WAKE_RESULT = {
  REJECTED: 'REJECTED',
  BARE_CENTRAL: 'BARE_CENTRAL',
  WAKE_WITH_UNIT: 'WAKE_WITH_UNIT',
  WAKE_WITH_REQUEST: 'WAKE_WITH_REQUEST',
};

export function parseWake(transcript) {
  const t = normalize(transcript);
  if (!t) return { kind: WAKE_RESULT.REJECTED };

  if (!/^central\b/.test(t)) return { kind: WAKE_RESULT.REJECTED };

  if (/^central$/.test(t)) return { kind: WAKE_RESULT.BARE_CENTRAL };

  let m = t.match(new RegExp(`^central\\s+from\\s+(${UNIT_TOKEN})\\s*(.*)$`));
  if (m) {
    const unit = normalizeUnitId(m[1]);
    const rest = (m[2] || '').trim();
    return rest
      ? { kind: WAKE_RESULT.WAKE_WITH_REQUEST, unit, remainder: rest }
      : { kind: WAKE_RESULT.WAKE_WITH_UNIT, unit };
  }

  m = t.match(new RegExp(`^central\\s+(${UNIT_TOKEN})\\s*(.*)$`));
  if (m) {
    const unit = normalizeUnitId(m[1]);
    const rest = (m[2] || '').trim();
    return rest
      ? { kind: WAKE_RESULT.WAKE_WITH_REQUEST, unit, remainder: rest }
      : { kind: WAKE_RESULT.WAKE_WITH_UNIT, unit };
  }

  return { kind: WAKE_RESULT.BARE_CENTRAL };
}

export const IDENTIFY_RESULT = {
  REJECTED: 'REJECTED',
  IDENTIFY_UNIT_ONLY: 'IDENTIFY_UNIT_ONLY',
  IDENTIFY_UNIT_WITH_REQUEST: 'IDENTIFY_UNIT_WITH_REQUEST',
  IDENTIFY_CENTRAL_UNIT: 'IDENTIFY_CENTRAL_UNIT',
};

export function parseIdentify(transcript) {
  const t = normalize(transcript);
  if (!t) return { kind: IDENTIFY_RESULT.REJECTED };

  let m = t.match(new RegExp(`^central\\s+(?:from\\s+)?(${UNIT_TOKEN})\\s*$`));
  if (m) return { kind: IDENTIFY_RESULT.IDENTIFY_CENTRAL_UNIT, unit: normalizeUnitId(m[1]) };

  m = t.match(new RegExp(`^(${UNIT_TOKEN})\\s*$`));
  if (m) return { kind: IDENTIFY_RESULT.IDENTIFY_UNIT_ONLY, unit: normalizeUnitId(m[1]) };

  m = t.match(new RegExp(`^(${UNIT_TOKEN})\\s+(.+)$`));
  if (m) {
    const unit = normalizeUnitId(m[1]);
    const remainder = m[2].trim();
    if (remainder) {
      return { kind: IDENTIFY_RESULT.IDENTIFY_UNIT_WITH_REQUEST, unit, remainder };
    }
  }

  return { kind: IDENTIFY_RESULT.REJECTED };
}

export const IDENTIFY_TIMEOUT_MS = 10000;
