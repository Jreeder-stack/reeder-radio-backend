import fs from 'fs';
import path from 'path';
import pool from '../db/index.js';

export const LEARNING_CATEGORIES = {
  LOCATION_ALIAS: 'LOCATION_ALIAS',
  CALLSIGN_NICKNAME: 'CALLSIGN_NICKNAME',
  PHRASING_ALIAS: 'PHRASING_ALIAS',
  TEN_CODE_SYNONYM: 'TEN_CODE_SYNONYM',
  NOTE_SHORTHAND: 'NOTE_SHORTHAND',
};

export const ALLOWED_CATEGORIES = new Set(Object.values(LEARNING_CATEGORIES));

export const FORBIDDEN_CATEGORIES = [
  'PERSONALITY',
  'TIER_RULES',
  'TEN_CODE_SEMANTICS',
  'ESCALATION_POLICY',
  'SAFETY_CONFIRMATION',
  'NEVER_SAY_RULES',
  'SYSTEM_PROMPT',
  'RAW_BACKEND_IDS',
];

const FORBIDDEN_PATTERNS = [
  { rx: /\b(system\s*prompt|change\s+(?:your|the)\s+personality|act\s+like|pretend\s+to\s+be|role[-\s]?play)\b/i, reason: 'attempts to modify personality/system prompt' },
  { rx: /\b(skip|bypass|ignore|disable|turn\s+off)\s+(?:the\s+)?(confirmation|safety|guardrail|escalation|tier|response\s+tier|verification)\b/i, reason: 'attempts to bypass safety/escalation' },
  { rx: /\bnever\s+(?:say|use|mention)\s+["'].*["']/i, reason: 'attempts to alter never-say rules' },
  { rx: /\balways\s+(?:say|reply|respond)\s+["']/i, reason: 'attempts to install fixed scripted responses' },
  { rx: /\b10[-\s]?\d{1,2}\b\s+(?:means?|=|is)\s+(?!.*synonym|.*also)/i, reason: 'attempts to redefine 10-code semantics' },
  { rx: /\b(call[-\s]?id|callid|incident[-\s]?id|cad[-\s]?id|guid|uuid|database\s+id|backend\s+id)\b/i, reason: 'references raw backend IDs' },
  { rx: /\b(emergency|signal\s*100|officer\s+down|officer\s+needs\s+help|10-33)\b/i, reason: 'attempts to teach emergency/escalation handling' },
  { rx: /\bclear[-\s]?air\b/i, reason: 'attempts to teach clear air handling' },
];

const MAX_FIELD_LENGTH = 200;
const MAX_TRANSCRIPT_LENGTH = 1000;

const LOG_DIR = path.join(process.cwd(), 'logs');
const SPEECH_LOG_FILE = path.join(LOG_DIR, 'ai-dispatch-speech.log');

function writeAuditLine(line) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(SPEECH_LOG_FILE, line + '\n');
  } catch (_) {}
}

function audit(action, details) {
  const ts = new Date().toISOString();
  const line = `[AI-DISPATCH-LEARNING] ${ts} | ${action} | ${JSON.stringify(details)}`;
  console.log(line);
  writeAuditLine(line);
}

export function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'candidate must be an object' };
  }
  const { category, original, correction } = candidate;
  if (!category || !ALLOWED_CATEGORIES.has(category)) {
    return { ok: false, reason: `category "${category}" is not in the allowed learning surface` };
  }
  if (!original || typeof original !== 'string' || original.trim().length < 1) {
    return { ok: false, reason: 'original is required' };
  }
  if (!correction || typeof correction !== 'string' || correction.trim().length < 1) {
    return { ok: false, reason: 'correction is required' };
  }
  if (original.length > MAX_FIELD_LENGTH || correction.length > MAX_FIELD_LENGTH) {
    return { ok: false, reason: 'original/correction exceeds maximum length' };
  }
  const combined = `${original}\n${correction}`;
  for (const { rx, reason } of FORBIDDEN_PATTERNS) {
    if (rx.test(combined)) {
      return { ok: false, reason: `guardrail violation: ${reason}` };
    }
  }
  return { ok: true };
}

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function recordCandidate({
  agencyId = 'default',
  unitId = null,
  channel = null,
  category,
  original,
  correction,
  transcript = null,
  sourceIntent = null,
}) {
  const validation = validateCandidate({ category, original, correction });
  if (!validation.ok) {
    audit('CANDIDATE_REJECTED_AT_CAPTURE', {
      agencyId, unitId, channel, category, original, correction, reason: validation.reason,
    });
    return { ok: false, reason: validation.reason };
  }

  const trimmedTranscript = transcript ? String(transcript).slice(0, MAX_TRANSCRIPT_LENGTH) : null;

  try {
    const dup = await pool.query(
      `SELECT id FROM dispatch_learning_candidates
        WHERE agency_id = $1 AND category = $2
          AND lower(original_text) = lower($3) AND lower(correction_text) = lower($4)
          AND status = 'pending'
        LIMIT 1`,
      [agencyId, category, original.trim(), correction.trim()]
    );
    if (dup.rows.length > 0) {
      audit('CANDIDATE_DUPLICATE', { agencyId, category, candidateId: dup.rows[0].id });
      return { ok: true, candidateId: dup.rows[0].id, duplicate: true };
    }
    const result = await pool.query(
      `INSERT INTO dispatch_learning_candidates
         (agency_id, unit_id, channel, category, original_text, correction_text, transcript, source_intent, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
       RETURNING id`,
      [agencyId, unitId, channel, category, original.trim(), correction.trim(), trimmedTranscript, sourceIntent]
    );
    const id = result.rows[0].id;
    audit('CANDIDATE_CAPTURED', { id, agencyId, unitId, channel, category, original, correction, sourceIntent });
    return { ok: true, candidateId: id };
  } catch (err) {
    console.error('[dispatcherLearning] recordCandidate failed:', err.message);
    return { ok: false, reason: `db error: ${err.message}` };
  }
}

export async function listCandidates({ agencyId = 'default', status = 'pending', limit = 200 } = {}) {
  const params = [agencyId, limit];
  let where = `agency_id = $1`;
  if (status && status !== 'all') {
    params.splice(1, 0, status);
    where += ` AND status = $2`;
  }
  const result = await pool.query(
    `SELECT id, agency_id, unit_id, channel, category, original_text, correction_text,
            transcript, source_intent, status, created_at, reviewed_at, reviewed_by, reject_reason
       FROM dispatch_learning_candidates
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function getPendingCount(agencyId = 'default') {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM dispatch_learning_candidates WHERE agency_id = $1 AND status = 'pending'`,
    [agencyId]
  );
  return r.rows[0]?.cnt || 0;
}

export async function approveCandidate(id, { editedOriginal = null, editedCorrection = null, editedCategory = null, reviewedBy = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cand = await client.query(
      `SELECT * FROM dispatch_learning_candidates WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (cand.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'candidate not found' };
    }
    const c = cand.rows[0];
    if (c.status !== 'pending') {
      await client.query('ROLLBACK');
      return { ok: false, reason: `candidate is ${c.status}, not pending` };
    }
    const finalCategory = editedCategory || c.category;
    const finalOriginal = (editedOriginal ?? c.original_text).trim();
    const finalCorrection = (editedCorrection ?? c.correction_text).trim();

    const validation = validateCandidate({ category: finalCategory, original: finalOriginal, correction: finalCorrection });
    if (!validation.ok) {
      await client.query(
        `UPDATE dispatch_learning_candidates SET status='rejected', reviewed_at=NOW(), reviewed_by=$2, reject_reason=$3 WHERE id=$1`,
        [id, reviewedBy, `guardrail-at-apply: ${validation.reason}`]
      );
      await client.query('COMMIT');
      audit('CANDIDATE_AUTO_REJECTED_AT_APPLY', { id, reason: validation.reason, reviewedBy });
      return { ok: false, reason: validation.reason };
    }

    const key = normalizeKey(finalOriginal);
    await client.query(
      `INSERT INTO dispatch_learned_items
         (agency_id, category, key_text, value_text, source_candidate_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (agency_id, category, key_text)
       DO UPDATE SET value_text = EXCLUDED.value_text,
                     source_candidate_id = EXCLUDED.source_candidate_id,
                     created_by = EXCLUDED.created_by,
                     updated_at = NOW()`,
      [c.agency_id, finalCategory, key, finalCorrection, id, reviewedBy]
    );
    await client.query(
      `UPDATE dispatch_learning_candidates
          SET status='approved', reviewed_at=NOW(), reviewed_by=$2,
              original_text=$3, correction_text=$4, category=$5
        WHERE id=$1`,
      [id, reviewedBy, finalOriginal, finalCorrection, finalCategory]
    );
    await client.query('COMMIT');
    invalidateCache(c.agency_id);
    audit('CANDIDATE_APPROVED', { id, agencyId: c.agency_id, category: finalCategory, original: finalOriginal, correction: finalCorrection, reviewedBy });
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[dispatcherLearning] approveCandidate failed:', err.message);
    return { ok: false, reason: err.message };
  } finally {
    client.release();
  }
}

export async function rejectCandidate(id, { reason = null, reviewedBy = null } = {}) {
  const r = await pool.query(
    `UPDATE dispatch_learning_candidates
        SET status='rejected', reviewed_at=NOW(), reviewed_by=$2, reject_reason=$3
      WHERE id=$1 AND status='pending'
      RETURNING id, agency_id`,
    [id, reviewedBy, reason]
  );
  if (r.rows.length === 0) return { ok: false, reason: 'not found or not pending' };
  audit('CANDIDATE_REJECTED', { id, reason, reviewedBy });
  return { ok: true };
}

export async function deleteLearnedItem(id, { reviewedBy = null } = {}) {
  const r = await pool.query(
    `DELETE FROM dispatch_learned_items WHERE id=$1 RETURNING agency_id`,
    [id]
  );
  if (r.rows.length === 0) return { ok: false, reason: 'not found' };
  invalidateCache(r.rows[0].agency_id);
  audit('LEARNED_ITEM_DELETED', { id, reviewedBy });
  return { ok: true };
}

export async function listLearnedItems(agencyId = 'default') {
  const r = await pool.query(
    `SELECT id, agency_id, category, key_text, value_text, created_at, updated_at, source_candidate_id, created_by
       FROM dispatch_learned_items WHERE agency_id = $1 ORDER BY category, key_text`,
    [agencyId]
  );
  return r.rows;
}

const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateCache(agencyId = 'default') {
  _cache.delete(agencyId);
}

export async function loadApprovedItems(agencyId = 'default') {
  const cached = _cache.get(agencyId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.items;
  try {
    const items = await listLearnedItems(agencyId);
    _cache.set(agencyId, { loadedAt: Date.now(), items });
    audit('LEARNED_ITEMS_LOADED', { agencyId, count: items.length });
    return items;
  } catch (err) {
    console.warn('[dispatcherLearning] loadApprovedItems failed:', err.message);
    return [];
  }
}

export async function getLearnedPlaces(agencyId = 'default') {
  const items = await loadApprovedItems(agencyId);
  return items
    .filter(i => i.category === LEARNING_CATEGORIES.LOCATION_ALIAS)
    .map(i => ({
      name: i.value_text,
      aliases: [i.key_text],
      address: i.value_text,
      category: 'learned',
      _learnedId: i.id,
    }));
}

export async function getLearnedCallsignAliases(agencyId = 'default') {
  const items = await loadApprovedItems(agencyId);
  const map = new Map();
  for (const i of items) {
    if (i.category === LEARNING_CATEGORIES.CALLSIGN_NICKNAME) {
      map.set(String(i.key_text).toLowerCase(), i.value_text);
    }
  }
  return map;
}

export async function getLearnedPhrasingAliases(agencyId = 'default') {
  const items = await loadApprovedItems(agencyId);
  const map = new Map();
  for (const i of items) {
    if (i.category === LEARNING_CATEGORIES.PHRASING_ALIAS || i.category === LEARNING_CATEGORIES.NOTE_SHORTHAND) {
      map.set(String(i.key_text).toLowerCase(), i.value_text);
    }
  }
  return map;
}

export async function getLearnedTenCodeSynonyms(agencyId = 'default') {
  const items = await loadApprovedItems(agencyId);
  const map = new Map();
  for (const i of items) {
    if (i.category === LEARNING_CATEGORIES.TEN_CODE_SYNONYM) {
      map.set(String(i.key_text).toLowerCase(), i.value_text);
    }
  }
  return map;
}

let _runtimeIndexByAgency = new Map();

export async function refreshRuntimeIndex(agencyId = 'default') {
  invalidateCache(agencyId);
  const items = await loadApprovedItems(agencyId);
  const places = items
    .filter(i => i.category === LEARNING_CATEGORIES.LOCATION_ALIAS)
    .map(i => ({ name: i.value_text, aliases: [i.key_text], address: i.value_text, category: 'learned', _learnedId: i.id }));
  const callsigns = new Map();
  const phrasings = new Map();
  const tenCodes = new Map();
  for (const i of items) {
    const k = String(i.key_text).toLowerCase();
    if (i.category === LEARNING_CATEGORIES.CALLSIGN_NICKNAME) callsigns.set(k, i.value_text);
    else if (i.category === LEARNING_CATEGORIES.PHRASING_ALIAS || i.category === LEARNING_CATEGORIES.NOTE_SHORTHAND) phrasings.set(k, i.value_text);
    else if (i.category === LEARNING_CATEGORIES.TEN_CODE_SYNONYM) tenCodes.set(k, i.value_text);
  }
  const idx = { places, callsigns, phrasings, tenCodes };
  _runtimeIndexByAgency.set(agencyId, idx);
  return idx;
}

export function getRuntimeIndex(agencyId = 'default') {
  return _runtimeIndexByAgency.get(agencyId) || { places: [], callsigns: new Map(), phrasings: new Map(), tenCodes: new Map() };
}

export function applyLearnedCallsign(unitText, agencyId = 'default') {
  if (!unitText) return unitText;
  const idx = getRuntimeIndex(agencyId);
  const key = normalizeKey(unitText);
  return idx.callsigns.get(key) || unitText;
}

export function applyLearnedPhrasing(text, agencyId = 'default') {
  if (!text) return text;
  const idx = getRuntimeIndex(agencyId);
  if (idx.phrasings.size === 0) return text;
  let out = String(text);
  for (const [k, v] of idx.phrasings) {
    if (!k) continue;
    const rx = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(rx, v);
  }
  return out;
}

export function applyLearnedTenCodeSynonyms(text, agencyId = 'default') {
  if (!text) return text;
  const idx = getRuntimeIndex(agencyId);
  if (idx.tenCodes.size === 0) return text;
  let out = String(text);
  for (const [k, v] of idx.tenCodes) {
    if (!k) continue;
    const rx = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(rx, v);
  }
  return out;
}

export function getDefaultAgencyId() {
  return process.env.AGENCY_ID || 'default';
}

const TEACHING_PATTERNS = [
  /\bremember\s+that\s+(.+?)\s+(?:means?|is|equals?)\s+(.+)$/i,
  /\bfrom\s+now\s+on[, ]+(.+?)\s+(?:means?|is|equals?)\s+(.+)$/i,
  /\bnote\s+that\s+(.+?)\s+(?:means?|is|equals?|=)\s+(.+)$/i,
  /\bteach\s+you\s+(?:that\s+)?(.+?)\s+(?:means?|is)\s+(.+)$/i,
];

export function detectTeachingPhrase(transcript) {
  if (!transcript || typeof transcript !== 'string') return null;
  const text = transcript.replace(/[.!?]+$/, '').trim();
  for (const rx of TEACHING_PATTERNS) {
    const m = text.match(rx);
    if (m) {
      const original = m[1].trim().replace(/^["']|["']$/g, '');
      const correction = m[2].trim().replace(/^["']|["']$/g, '');
      if (original && correction && original.toLowerCase() !== correction.toLowerCase()) {
        return { original, correction };
      }
    }
  }
  return null;
}

export function inferCategory({ original, correction }) {
  const o = (original || '').toLowerCase();
  const c = (correction || '').toLowerCase();
  if (/^\d+\s+\w/.test(c) || /\b(st|ave|blvd|rd|ln|dr|pl|ct|pkwy|way|highway|hwy)\b/i.test(c) || /,\s*[A-Z]{2}\b/.test(correction)) {
    return LEARNING_CATEGORIES.LOCATION_ALIAS;
  }
  if (/^[a-z]+[-\s]?\d{1,3}$/i.test(c) || /^\d{3,5}$/.test(c)) {
    return LEARNING_CATEGORIES.CALLSIGN_NICKNAME;
  }
  if (/^10[-\s]?\d{1,2}$/.test(o) || /^10[-\s]?\d{1,2}$/.test(c)) {
    return LEARNING_CATEGORIES.TEN_CODE_SYNONYM;
  }
  return LEARNING_CATEGORIES.PHRASING_ALIAS;
}
