import { AzureOpenAI } from 'openai';
import { V3_ACTIONS, V3_UNIT_STATUSES, listV3Actions } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { planDeterministicV3Intent } from './deterministicIntent.js';
import { sanitizeV3OperationalContext } from './operationalContext.js';

const DEFAULT_TIMEOUT_MS = 6500;
const CONTROL_ACTIONS = new Set(['NO_ACTION', 'CLARIFY']);
const MAX_PLAN_ACTIONS = 4;
const EMERGENCY_RX = /\b(officer\s+down|shots?\s+fired|10[-\s/]?33|ten\s+thirty[-\s]?three|emergency\s+traffic|signal\s+100|declare\s+an?\s+emergency)\b/i;
let defaultClient = null;

export function isV3PlannerConfigured() {
  return Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT);
}

export class V3IntentPlanner {
  constructor({ client = null, timeoutMs = DEFAULT_TIMEOUT_MS, diagnostics = null } = {}) {
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.diagnostics = diagnostics;
  }

  async plan({ transcript, speakerCallsign, runtimeContext, correlationId, recentContext = [], operationalContext = null } = {}) {
    const text = String(transcript || '').trim();
    if (!text) return Object.freeze({ action: 'NO_ACTION', input: {}, confidence: 1, reason: 'empty_transcript' });

    if (EMERGENCY_RX.test(text)) {
      return Object.freeze({ action: V3_ACTIONS.DECLARE_EMERGENCY, input: Object.freeze({ unitRef: speakerCallsign, reason: text }), confidence: 1, reason: 'protected_emergency_phrase' });
    }

    const deterministic = planDeterministicV3Intent({ transcript: text, speakerCallsign, operationalContext });
    if (deterministic) {
      this._diag('intent_planned_deterministic', runtimeContext, correlationId, true, 0, { transcript: text, plan: deterministic });
      return deterministic;
    }

    const client = this.client || getDefaultClient();
    if (!client) throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE, 'Azure OpenAI is not configured for Dispatcher V3', { statusCode: 503, retryable: true });

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await client.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: JSON.stringify({
            transcript: text,
            speakerCallsign,
            dispatchCenterId: runtimeContext?.dispatchCenterId,
            channel: runtimeContext?.roomKey,
            operationalContext: sanitizeV3OperationalContext(operationalContext),
            recentContext: sanitizeRecent(recentContext),
          }) },
        ],
      }, { signal: controller.signal });
      const raw = response?.choices?.[0]?.message?.content || '{}';
      const plan = normalizePlan(JSON.parse(raw));
      this._diag('intent_planned', runtimeContext, correlationId, true, Date.now() - started, { transcript: text, plan });
      return plan;
    } catch (error) {
      const timeout = error?.name === 'AbortError';
      this._diag('intent_failed', runtimeContext, correlationId, false, Date.now() - started, { transcript: text, message: error.message, timeout });
      throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE, timeout ? 'Dispatcher V3 intent planning timed out' : 'Dispatcher V3 intent planning failed', { statusCode: 503, retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  _diag(phase, runtimeContext, correlationId, success, latencyMs, details) {
    this.diagnostics?.record?.({ phase, correlationId, runtimeId: runtimeContext?.runtimeId || null, dispatchCenterId: runtimeContext?.dispatchCenterId || null, channelId: runtimeContext?.channelId || null, success, latencyMs, details });
  }
}

function getDefaultClient() {
  if (!isV3PlannerConfigured()) return null;
  if (!defaultClient) {
    defaultClient = new AzureOpenAI({ apiKey: process.env.AZURE_OPENAI_API_KEY, endpoint: process.env.AZURE_OPENAI_ENDPOINT, deployment: process.env.AZURE_OPENAI_DEPLOYMENT, apiVersion: '2024-08-01-preview' });
  }
  return defaultClient;
}

function normalizePlan(raw = {}) {
  if (Array.isArray(raw.actions) && raw.actions.length > 0) {
    if (raw.actions.length > MAX_PLAN_ACTIONS) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, `Planner returned more than ${MAX_PLAN_ACTIONS} actions`);
    const actions = raw.actions.map((item) => normalizeOperationalAction(item));
    const confidence = normalizeConfidence(raw.confidence);
    return Object.freeze({
      action: 'MULTI_ACTION',
      actions: Object.freeze(actions),
      input: Object.freeze({}),
      confidence,
      clarification: null,
      reason: clean(raw.reason, 200),
    });
  }

  const action = String(raw.action || 'NO_ACTION').trim().toUpperCase();
  if (!CONTROL_ACTIONS.has(action) && !listV3Actions().includes(action)) {
    throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION, `Planner returned unsupported action ${action}`);
  }
  const input = normalizeInputObject(raw.input);
  const clarification = clean(raw.clarification, 180);
  if (action === 'CLARIFY' && !clarification) {
    throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'Planner clarification is missing text');
  }
  return Object.freeze({ action, input: Object.freeze(input), confidence: normalizeConfidence(raw.confidence), clarification, reason: clean(raw.reason, 200) });
}

function normalizeOperationalAction(raw = {}) {
  const action = String(raw.action || '').trim().toUpperCase();
  if (!listV3Actions().includes(action)) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION, `Planner returned unsupported multi-action ${action}`);
  return Object.freeze({ action, input: Object.freeze(normalizeInputObject(raw.input)) });
}

function normalizeInputObject(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
}

function systemPrompt() {
  return `You are the intent planner for a public-safety radio dispatcher. Return JSON only. Never claim an action succeeded; execution happens elsewhere.\n\nAllowed operational actions: ${listV3Actions().join(', ')}. Control actions: NO_ACTION, CLARIFY.\nCanonical unit statuses: ${V3_UNIT_STATUSES.join(', ')}.\n\nAct like an experienced human dispatcher. Understand natural phrasing instead of requiring scripts. Use the supplied operationalContext to resolve obvious references. The operationalContext.units list is the authoritative center-scoped roster available to this dispatcher. When the user names another callsign or clearly refers to another listed unit, unitRef MUST be that named unit, never the transmitting speaker. Default unitRef to the speaker only when the request actually concerns the speaker. If a named unit does not uniquely match the roster, CLARIFY instead of silently substituting the speaker.\n\nIf exactly one active call can safely satisfy phrases such as "the call", "that call", "attach me", "put me on it", or another implicit call reference, do NOT ask for a call number; emit the requested action and allow execution to resolve that single active call. If more than one materially plausible call exists, use CLARIFY with one short question. Never guess across dispatch centers or ambiguous units.\n\nFor ONE requested operation return {"action":"...","confidence":0-1,"input":{},"clarification":null,"reason":"short"}.\nFor MULTIPLE requested operations in the same transmission return {"actions":[{"action":"...","input":{}},{"action":"...","input":{}}],"confidence":0-1,"reason":"short"}. Preserve the user's requested order and include every explicitly requested operation, up to ${MAX_PLAN_ACTIONS}. Example: "create a building check at 100 Main and show me en route" must return CREATE_CALL first and SET_UNIT_STATUS second.\nUse spoken callsigns only in temporary fields named unitRef or unitRefs. Never invent UUIDs, call IDs, locations, dispositions, zones, or facts. For CREATE_CALL requested by the speaker, include the speaker in unitRefs unless the user clearly says not to assign themselves. When recentContext shows a CLARIFY turn, treat the new transcript as the answer to that pending question and combine it with the prior input instead of restarting the request.\nWhen a call is referred to naturally but no UUID is spoken, use callRef for the user's words (for example "Walmart alarm", "Smith's call", "that alarm"). If the reference is purely implicit and operationalContext makes the target unique, callRef may be omitted. Do not CLARIFY merely because callId is absent.\nMappings: SET_UNIT_STATUS input={unitRef,status,note?}; CHANGE_UNIT_ZONE={unitRef,zone}; GET_CURRENT_CALL={unitRef}; CREATE_CALL={type,location,city?,municipality?,priority?,description?,unitRefs?}; ADD_CALL_NOTE={callId?,callRef?,note,unitRef?}; ASSIGN_UNIT={callId?,callRef?,unitRef}; CLEAR_UNIT={callId?,callRef?,unitRef,disposition?}; CLOSE_CALL={callId,disposition,unitRefs?,note?}; STATUS_CHECK={unitRef}; REQUEST_BACKUP={unitRef,callId?,location?,priority?,reason?}; DECLARE_EMERGENCY={unitRef,callId?,location?,reason?}; RADIO_CHECK/TIME_CHECK may use {unitRef?}. Do not output prose outside JSON.`;
}

function sanitizeRecent(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-6).map((item) => ({ transcript: clean(item?.transcript, 240), action: clean(item?.action, 40), input: sanitizeInput(item?.input), clarification: clean(item?.clarification, 180), success: item?.success === true }));
}

function sanitizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') result[key] = clean(value, 180);
    else if (Array.isArray(value)) result[key] = value.slice(0, 8).map((item) => clean(item, 80)).filter(Boolean);
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  return result;
}

function clean(value, max = 300) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : null;
}
