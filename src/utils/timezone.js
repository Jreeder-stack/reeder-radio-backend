export const DISPATCHER_TZ = 'America/New_York';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) {
  return n.toString().padStart(2, '0');
}

function partsForZone(date, timeZone, opts = {}) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...opts,
  });
  const parts = fmt.formatToParts(date);
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  if (out.hour === '24') out.hour = '00';
  return out;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = DATE_ONLY_RE.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

export function utcDateToLocalDate(value, timeZone = DISPATCHER_TZ) {
  const d = toDate(value);
  if (!d) return null;
  const p = partsForZone(d, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localDateToUtcDate(value, timeZone = DISPATCHER_TZ) {
  if (!value) return null;
  let local;
  if (typeof value === 'string' && DATE_ONLY_RE.test(value.trim())) {
    local = value.trim();
  } else {
    const d = toDate(value);
    if (!d) return null;
    local = utcDateToLocalDate(d, timeZone);
  }

  for (const offset of [0, 1, -1, 2]) {
    const candidate = new Date(`${local}T00:00:00Z`);
    candidate.setUTCDate(candidate.getUTCDate() + offset);
    const utcStr = candidate.toISOString().slice(0, 10);
    if (utcDateToLocalDate(utcStr, timeZone) === local) {
      return utcStr;
    }
  }
  return local;
}

export function utcDateTimeToLocalDateTime(value, timeZone = DISPATCHER_TZ) {
  const d = toDate(value);
  if (!d) return null;
  const p = partsForZone(d, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function formatLocalSpokenTime24(value = new Date(), timeZone = DISPATCHER_TZ) {
  const d = toDate(value) || new Date();
  const p = partsForZone(d, timeZone);
  return { hour: parseInt(p.hour, 10), minute: parseInt(p.minute, 10) };
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/;

export function maybeUtcToLocalForSpeech(value, timeZone = DISPATCHER_TZ) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (DATE_ONLY_RE.test(trimmed)) {
    return utcDateToLocalDate(trimmed, timeZone) || value;
  }
  if (ISO_DATETIME_RE.test(trimmed)) {
    const local = utcDateTimeToLocalDateTime(trimmed, timeZone);
    return local || value;
  }
  return value;
}

export function formatLocalDateForSpeech(value = new Date(), timeZone = DISPATCHER_TZ) {
  const d = toDate(value) || new Date();
  const p = partsForZone(d, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
