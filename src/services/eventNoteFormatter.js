const EVENT_TYPE_NOTE_LABELS = {
  CUSTODY: 'IN CUSTODY',
  GUNPOINT: 'AT GUNPOINT',
  TASER_POINT: 'AT TASER POINT',
  TASER_DEPLOYED: 'TASER DEPLOYED',
  FOOT_PURSUIT: 'FOOT PURSUIT',
  VEHICLE_PURSUIT: 'VEHICLE PURSUIT',
  FIGHTING: 'FIGHTING',
  OFFICER_NEEDS_HELP: 'OFFICER NEEDS HELP',
};

const EVENT_TYPE_SPOKEN = {
  CUSTODY: 'in custody',
  GUNPOINT: 'at gunpoint',
  TASER_POINT: 'at taser point',
  TASER_DEPLOYED: 'taser deployed',
  FOOT_PURSUIT: 'foot pursuit',
  VEHICLE_PURSUIT: 'vehicle pursuit',
  FIGHTING: 'fighting',
  OFFICER_NEEDS_HELP: 'emergency assist',
};

const NON_CUSTODY_EVENT_TYPES = new Set([
  'GUNPOINT', 'TASER_POINT', 'TASER_DEPLOYED',
  'FOOT_PURSUIT', 'VEHICLE_PURSUIT', 'FIGHTING', 'OFFICER_NEEDS_HELP',
]);

const ENTRY_BASED_EVENT_TYPES = new Set(['CUSTODY', 'GUNPOINT', 'TASER_POINT']);

export function isClearAirEventType(eventType) {
  return NON_CUSTODY_EVENT_TYPES.has(String(eventType || '').toUpperCase());
}

export function getEventSpokenLabel(eventType) {
  const key = String(eventType || '').toUpperCase();
  return EVENT_TYPE_SPOKEN[key] || key.toLowerCase().replace(/_/g, ' ');
}

function normalizeGender(g) {
  if (!g) return null;
  const v = String(g).trim().toLowerCase();
  if (!v) return null;
  if (['male', 'm', 'man', 'males', 'men'].includes(v)) return 'MALE';
  if (['female', 'f', 'woman', 'females', 'women'].includes(v)) return 'FEMALE';
  if (['juvenile', 'juv', 'minor', 'juveniles'].includes(v)) return 'JUVENILE';
  if (['juvenile male', 'juv male', 'juvenile m', 'juvenile males'].includes(v)) return 'JUVENILE MALE';
  if (['juvenile female', 'juv female', 'juvenile f', 'juvenile females'].includes(v)) return 'JUVENILE FEMALE';
  return null;
}

function clampCount(c) {
  const n = parseInt(c, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function formatCountPrefix(count) {
  if (count > 9) return 'NX';
  return `${count}X`;
}

function formatEntry(eventType, entry) {
  const count = clampCount(entry?.count);
  const gender = normalizeGender(entry?.gender);
  const label = EVENT_TYPE_NOTE_LABELS[eventType] || eventType;
  const prefix = formatCountPrefix(count);
  if (gender) {
    return `${prefix} ${gender} ${label}`;
  }
  return `${prefix} ${label}`;
}

export function formatEventNote(eventType, entries = []) {
  const key = String(eventType || '').toUpperCase();
  const label = EVENT_TYPE_NOTE_LABELS[key];
  if (!label) return null;

  if (ENTRY_BASED_EVENT_TYPES.has(key)) {
    const list = Array.isArray(entries) && entries.length > 0
      ? entries
      : [{ count: 1, gender: null }];
    return list.map((e) => formatEntry(key, e)).join(', ');
  }

  if (key === 'FIGHTING') {
    const total = (Array.isArray(entries) && entries.length > 0)
      ? entries.reduce((sum, e) => sum + clampCount(e?.count), 0)
      : 1;
    if (total > 1) return `FIGHTING WITH ${formatCountPrefix(total)} SUBJECTS`;
    return 'FIGHTING WITH SUBJECT';
  }

  return label;
}

export function formatDescriptionNote(eventType, description) {
  const desc = (description || '').toString().trim();
  if (!desc) return null;
  const key = String(eventType || '').toUpperCase();
  const label = EVENT_TYPE_NOTE_LABELS[key] || key;
  const cleaned = desc.replace(/\s+/g, ' ').toUpperCase();
  return `${label} - DESCRIPTION: ${cleaned}`;
}

const ALL_CLEAR_PHRASES = [
  /\ball\s*clear\b/i,
  /\bcode\s*4\b/i,
  /\bcode\s*four\b/i,
  /\bwe(?:'?re|\s+are)\s+good\b/i,
  /\bwe(?:'?re|\s+are)\s+10-?4\b/i,
  /\bsituation\s+under\s+control\b/i,
  /\bunder\s+control\b/i,
  /\b10-?22\b/i,
  /\bten\s+twenty\s*two\b/i,
];

export function isAllClearPhrase(transcript) {
  if (!transcript) return false;
  const t = String(transcript).toLowerCase();
  return ALL_CLEAR_PHRASES.some((rx) => rx.test(t));
}

const NUMBER_WORDS = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
  couple: 2, 'a couple': 2, several: 3,
};

function parseCount(token) {
  if (!token) return 1;
  const t = String(token).trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\d+$/.test(t)) return clampCount(t);
  if (t === 'a couple' || t === 'a couple of' || t === 'couple of' || t === 'couple') return 2;
  return NUMBER_WORDS[t] || 1;
}

function parseGenderToken(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  if (t.includes('juvenile') && t.includes('male')) return 'JUVENILE MALE';
  if (t.includes('juvenile') && t.includes('female')) return 'JUVENILE FEMALE';
  if (t.includes('juvenile')) return 'JUVENILE';
  if (/\bmales?\b/.test(t) || /\bmen\b/.test(t)) return 'MALE';
  if (/\bfemales?\b/.test(t) || /\bwomen\b/.test(t)) return 'FEMALE';
  return null;
}

const COUNT_RX = '(?:\\d+|a\\s+couple\\s+of|a\\s+couple|couple\\s+of|one|a|an|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|couple|several)';
const GENDER_RX = '(?:juvenile\\s+males?|juvenile\\s+females?|juveniles?|males?|females?|men|women)';

function extractEntriesForLabel(text, labelRxStr) {
  const rx = new RegExp(
    `(${COUNT_RX})\\s+(?:(${GENDER_RX})\\s+)?(?:subjects?|suspects?|persons?|people)?\\s*${labelRxStr}`,
    'gi'
  );
  const entries = [];
  let m;
  while ((m = rx.exec(text)) !== null) {
    entries.push({ count: parseCount(m[1]), gender: parseGenderToken(m[2]) });
  }
  return entries;
}

function extractMixedCustodyEntries(text) {
  const splitRx = new RegExp(
    `(${COUNT_RX})\\s+(${GENDER_RX})(?=\\s+(?:and|&|,)\\s+${COUNT_RX}\\s+${GENDER_RX}|\\s+(?:in\\s+custody|at\\s+gun\\s*point|at\\s+taser\\s*point))`,
    'gi'
  );
  const out = [];
  let m;
  while ((m = splitRx.exec(text)) !== null) {
    out.push({ count: parseCount(m[1]), gender: parseGenderToken(m[2]) });
  }
  return out;
}

const DESCRIPTOR_TOKEN_RX = /\b(black|white|hispanic|latino|asian|native|male|female|men|women|juvenile|teen|adult|tall|short|skinny|thin|heavy|stocky|chubby|long\s+hair|short\s+hair|wearing|with\s+a|red|blue|green|yellow|orange|purple|pink|brown|gray|grey|silver|gold|hat|cap|hoodie|jacket|shirt|pants|shorts|jeans|shoes|sneakers|boots|backpack|gun|knife|weapon|northbound|southbound|eastbound|westbound|toward|towards|honda|toyota|ford|chevy|chevrolet|nissan|hyundai|kia|jeep|sedan|coupe|truck|suv|van|plate|tag\s+number|license)\b/i;

function maybeExtractDescription(original, triggerRx) {
  if (!original) return null;
  const m = original.match(triggerRx);
  if (!m || m.index === undefined) return null;
  const tail = original.slice(m.index + m[0].length).trim().replace(/^[\s,.-]+/, '').trim();
  if (tail.length < 3) return null;
  if (DESCRIPTOR_TOKEN_RX.test(tail)) return tail;
  return null;
}

export function matchEventFromTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') return null;
  const text = transcript.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  const original = transcript.trim();
  const buildResult = (eventType, entries, triggerRx) => ({
    intent: 'LOG_EVENT_NOTE',
    eventType,
    entries,
    description: maybeExtractDescription(original, triggerRx),
    response: null,
  });

  const officerHelpRx = /(officer\s+needs?\s+help|officer\s+down|officers?\s+down|10-?33|ten\s+thirty\s*three|i\s+need\s+help|send\s+help|need\s+(?:emergency\s+)?help)/i;
  if (officerHelpRx.test(text)) return buildResult('OFFICER_NEEDS_HELP', [], officerHelpRx);

  if (/\b(taser\s+deployed|deployed\s+(?:my\s+)?taser|tased\s+(?:the\s+)?subject)\b/i.test(text)) {
    return buildResult('TASER_DEPLOYED', [], /taser\s+deployed|deployed\s+(?:my\s+)?taser|tased/i);
  }

  const taserPointEntries = extractEntriesForLabel(text, '(?:at\\s+)?taser\\s*point');
  if (taserPointEntries.length > 0) return buildResult('TASER_POINT', taserPointEntries, /taser\s*point/i);
  if (/\b(at\s+taser\s*point|taser\s*point)\b/i.test(text)) {
    return buildResult('TASER_POINT', [{ count: 1, gender: null }], /taser\s*point/i);
  }

  const gunpointMixed = extractMixedCustodyEntries(text);
  const gunpointEntries = extractEntriesForLabel(text, '(?:at\\s+)?gun\\s*point');
  if (/\b(gun\s*point|at\s+gun\s*point|subject\s+at\s+gun\s*point)\b/i.test(text)) {
    const entries = gunpointEntries.length > 0 ? gunpointEntries : (gunpointMixed.length > 0 ? gunpointMixed : [{ count: 1, gender: null }]);
    return buildResult('GUNPOINT', entries, /gun\s*point/i);
  }

  if (/\b(fighting|wrestling|in\s+a\s+struggle|struggling\s+with|we(?:'?re|\s+are)\s+fighting)\b/i.test(text)) {
    return buildResult('FIGHTING', [], /fighting|wrestling|struggle|struggling/i);
  }

  if (/\b(vehicle\s+pursuit|car\s+pursuit|pursuing\s+(?:a\s+|the\s+)?(?:vehicle|car)|in\s+pursuit\s*,?\s*vehicle|10-?80|ten\s+eighty)\b/i.test(text)) {
    return buildResult('VEHICLE_PURSUIT', [], /vehicle\s+pursuit|car\s+pursuit|pursuing|10-?80|ten\s+eighty/i);
  }

  if (/\b(foot\s+pursuit|foot\s+suit|on\s+foot|subject\s+running|he'?s\s+running|she'?s\s+running|they'?re\s+running|running\s+on\s+foot|in\s+foot\s+pursuit|pursuing\s+on\s+foot)\b/i.test(text)) {
    return buildResult('FOOT_PURSUIT', [], /foot\s+pursuit|on\s+foot|running/i);
  }

  if (/\bin\s+pursuit\b/i.test(text) && !/\b(vehicle|car)\b/i.test(text)) {
    return buildResult('FOOT_PURSUIT', [], /in\s+pursuit/i);
  }

  if (/\bin\s+custody\b/i.test(text)) {
    const mixed = extractMixedCustodyEntries(text);
    const single = extractEntriesForLabel(text, 'in\\s+custody');
    let entries;
    if (mixed.length >= 2) {
      entries = mixed;
    } else if (single.length > 0) {
      entries = single;
    } else {
      entries = [{ count: 1, gender: null }];
    }
    return buildResult('CUSTODY', entries, /in\s+custody/i);
  }
  if (/\b(have\s+one|subject\s+detained|10-?15|ten\s+fifteen)\b/i.test(text)) {
    return buildResult('CUSTODY', [{ count: 1, gender: null }], /have\s+one|subject\s+detained|10-?15|ten\s+fifteen/i);
  }

  return null;
}
