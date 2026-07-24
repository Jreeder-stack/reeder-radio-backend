const SPOKEN_NUMBER_WORD = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const UNIT_TOKEN = `(?:[a-z]+(?:[\\s-]+(?:dash[\\s-]+)?)?(?:\\d{1,3}|${SPOKEN_NUMBER_WORD}(?:[\\s-]+${SPOKEN_NUMBER_WORD}){0,3})|\\d{4})`;

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

const DIGIT_WORDS = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

const SMALL_NUMBER_WORDS = {
  ...DIGIT_WORDS,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS_WORDS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function normalize(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[.,!?]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSpokenUnitNumber(value) {
  const tokens = String(value || '').toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (!tokens.length) return null;

  if (tokens.every(token => Object.prototype.hasOwnProperty.call(DIGIT_WORDS, token))) {
    return Number(tokens.map(token => DIGIT_WORDS[token]).join(''));
  }

  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (token === 'hundred') {
      current = Math.max(current, 1) * 100;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TENS_WORDS, token)) {
      current += TENS_WORDS[token];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SMALL_NUMBER_WORDS, token)) {
      current += SMALL_NUMBER_WORDS[token];
      continue;
    }
    return null;
  }
  total += current;
  return Number.isInteger(total) && total >= 0 && total <= 999 ? total : null;
}

export function normalizeUnitId(s) {
  if (!s) return null;
  const raw = normalize(s);
  if (/^\d{4}$/.test(raw)) return raw;

  let match = raw.match(/^([a-z]+)(?:\s+dash)?[\s-]*(\d{1,3})$/i);
  if (match) return `${match[1].toUpperCase()}-${match[2]}`;

  match = raw.match(/^([a-z]+)(?:\s+dash)?\s+(.+)$/i);
  if (match) {
    const spokenNumber = parseSpokenUnitNumber(match[2]);
    if (spokenNumber !== null) {
      return `${match[1].toUpperCase()}-${spokenNumber}`;
    }
  }

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
