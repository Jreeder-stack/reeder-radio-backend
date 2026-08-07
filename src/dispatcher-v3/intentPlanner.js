import { AzureOpenAI } from 'openai';
import { V3_ACTIONS, V3_UNIT_STATUSES, listV3Actions } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const DEFAULT_TIMEOUT_MS = 6500;
const CONTROL_ACTIONS = new Set(['NO_ACTION', 'CLARIFY']);
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

  async plan({ transcript, speakerCallsign, runtimeContext, correlationId, recentContext = [] } = {}) {
    const text = String(transcript || '').trim();
    if (!text) return Object.freeze({ action: 'NO_ACTION', input: {}, confidence: 1, reason: 'empty_transcript' });

    if (EMERGENCY_RX.test(text)) {
      return Object.freeze({ action: V3_ACTIONS.DECLARE_EMERGENCY, input: Object.freeze({ unitRef: speakerCallsign, reason: text }), confidence: 1, reason: 'protected_emergency_phrase' });
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
          { role: 'user', content: JSON.stringify({ transcript: text, speakerCallsign, dispatchCenterId: runtimeContext?.dispatchCenterId, channel: runtimeContext?.roomKey, recentContext: sanitizeRecent(recentContext) }) },
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
    this.diagnostics?.record?.({
      phase,
      correlationId,
      runtimeId: runtimeContext?.runtimeId || null,
      dispatchCenterId: runtimeContext?.dispatchCenterId || null,
      channelId: runtimeContext?.channelId || null,
      success,
      latencyMs,
      details,
    });
  }
}

function getDefaultClient() {
  if (!isV3PlannerConfigured()) return null;
  if (!defaultClient) {
    defaultClient = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
      apiVersion: '2024-08-01-preview',
    });
  }
  return defaultClient;
}

function normalizePlan(raw = {}) {
  const action = String(raw.action || 'NO_ACTION').trim().toUpperCase();
  if (!CONTROL_ACTIONS.has(action) && !listV3Actions().includes(action)) {
    throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION, `Planner returned unsupported action ${action}`);
  }
  const confidence = Number(raw.confidence);
  const input = raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input) ? raw.input : {};
  const clarification = clean(raw.clarification, 180);
  if (action === 'CLARIFY' && !clarification) {
    throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'Planner clarification is missing text');
  }
  return Object.freeze({
    action,
    input: Object.freeze({ ...input }),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    clarification,
    reason: clean(raw.reason, 200),
  });
}

function systemPrompt() {
  return `You are the intent planner for a public-safety radio dispatcher. Return JSON only. Never claim an action succeeded; execution happens elsewhere.\n\nAllowed operational actions: ${listV3Actions().join(', ')}. Control actions: NO_ACTION, CLARIFY.\nCanonical unit statuses: ${V3_UNIT_STATUSES.join(', ')}.\n\nReturn: {"action":"...","confidence":0-1,"input":{},"clarification":null,"reason":"short"}.\nUse spoken callsigns only in temporary fields named unitRef or unitRefs. Never invent UUIDs, call IDs, locations, dispositions, or facts. If required information is missing, use CLARIFY and ask one short radio question. Default unitRef to the speaker when the command concerns the speaker. When recentContext shows a CLARIFY turn, treat the new transcript as the answer to that pending question and combine it with the prior input instead of restarting the request.\nMappings: SET_UNIT_STATUS input={unitRef,status,note?}; GET_CURRENT_CALL={unitRef}; CREATE_CALL={type,location,city?,municipality?,priority?,description?,unitRefs?}; ADD_CALL_NOTE={callId,note,unitRef?}; ASSIGN_UNIT={callId,unitRef}; CLEAR_UNIT={callId,unitRef,disposition?}; CLOSE_CALL={callId,disposition,unitRefs?,note?}; STATUS_CHECK={unitRef}; REQUEST_BACKUP={unitRef,callId?,location?,priority?,reason?}; DECLARE_EMERGENCY={unitRef,callId?,location?,reason?}; RADIO_CHECK/TIME_CHECK may use {unitRef?}. Do not output prose outside JSON.`;
}

function sanitizeRecent(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-6).map((item) => ({
    transcript: clean(item?.transcript, 240),
    action: clean(item?.action, 40),
    input: sanitizeInput(item?.input),
    clarification: clean(item?.clarification, 180),
    success: item?.success === true,
  }));
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
