import { AzureOpenAI } from 'openai';
import { V3_ACTIONS, V3_UNIT_STATUSES, V3_CALL_STATUSES, listV3Actions } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { planDeterministicV3Intent } from './deterministicIntent.js';
import { sanitizeV3OperationalContext } from './operationalContext.js';

const DEFAULT_TIMEOUT_MS = 6500;
const CONTROL_ACTIONS = new Set(['NO_ACTION', 'CLARIFY']);
const MAX_PLAN_ACTIONS = 10;
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

  async plan({ transcript, speakerCallsign, runtimeContext, correlationId, recentContext = [], operationalContext = null, pendingContext = null, dialogueContext = null } = {}) {
    const text = String(transcript || '').trim();
    if (!text) return Object.freeze({ action: 'NO_ACTION', input: {}, confidence: 1, reason: 'empty_transcript' });

    const deterministic = planDeterministicV3Intent({ transcript: text, speakerCallsign, operationalContext, pendingContext });
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
            pendingContext: sanitizeInput(pendingContext),
            dialogueContext: sanitizeInput(dialogueContext),
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
  if (!defaultClient) defaultClient = new AzureOpenAI({ apiKey: process.env.AZURE_OPENAI_API_KEY, endpoint: process.env.AZURE_OPENAI_ENDPOINT, deployment: process.env.AZURE_OPENAI_DEPLOYMENT, apiVersion: '2024-08-01-preview' });
  return defaultClient;
}

function normalizePlan(raw = {}) {
  if (Array.isArray(raw.actions) && raw.actions.length > 0) {
    if (raw.actions.length > MAX_PLAN_ACTIONS) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, `Planner returned more than ${MAX_PLAN_ACTIONS} actions`);
    const actions = raw.actions.map((item) => normalizeOperationalAction(item));
    return Object.freeze({ action: 'MULTI_ACTION', actions: Object.freeze(actions), input: Object.freeze({}), confidence: normalizeConfidence(raw.confidence), clarification: null, reason: clean(raw.reason, 200) });
  }

  const action = String(raw.action || 'NO_ACTION').trim().toUpperCase();
  if (!CONTROL_ACTIONS.has(action) && !listV3Actions().includes(action)) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION, `Planner returned unsupported action ${action}`);
  const input = normalizeInputObject(raw.input);
  const clarification = clean(raw.clarification, 180);
  if (action === 'CLARIFY' && !clarification) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'Planner clarification is missing text');
  return Object.freeze({ action, input: Object.freeze(input), confidence: normalizeConfidence(raw.confidence), clarification, reason: clean(raw.reason, 200) });
}

function normalizeOperationalAction(raw = {}) {
  const action = String(raw.action || '').trim().toUpperCase();
  if (!listV3Actions().includes(action)) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION, `Planner returned unsupported multi-action ${action}`);
  return Object.freeze({ action, input: Object.freeze(normalizeInputObject(raw.input)) });
}

function normalizeInputObject(input) { return input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {}; }
function normalizeConfidence(value) { const confidence = Number(value); return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0; }

function systemPrompt() {
  const voiceActions = listV3Actions().filter((action) => action !== V3_ACTIONS.DECLARE_EMERGENCY);
  return `You are the intent planner for a public-safety radio dispatcher. Return JSON only. Never claim an action succeeded; execution happens elsewhere.

Allowed voice actions: ${voiceActions.join(', ')}. Control actions: NO_ACTION, CLARIFY.
Canonical unit statuses: ${V3_UNIT_STATUSES.join(', ')}. Canonical call statuses: ${V3_CALL_STATUSES.join(', ')}.

Act like an experienced human dispatcher. Understand meaning, grammar, inflection, and operational context instead of requiring scripted phrases. Evaluate every transmission independently. A previous question is a follow-up goal, never a gate. If the unit gives different operational information or changes direction, capture the new information and choose the appropriate action. Do not repeat a question merely because the newest transmission did not answer it.

Only a physical emergency-button event may activate the emergency system. A voice transcript can NEVER produce DECLARE_EMERGENCY, regardless of wording. Shots fired, officer down, 10-33, emergency traffic, taking fire, gunpoint, taser point, and fighting are urgent CAD traffic. Use REPORT_FIELD_INCIDENT, REQUEST_BACKUP, CREATE_CALL, or ADD_CALL_NOTE without activating the emergency system.

Use operationalContext to resolve references. operationalContext.units is the authoritative center-scoped roster. When another callsign is named, unitRef MUST be that unit. Default to the speaker only when the operation concerns the speaker. Preserve an unknown unit-like callsign as unitRef so authoritative resolution returns UNIT_NOT_FOUND; never silently replace it with the speaker. If a named unit is ambiguous, CLARIFY. Never guess across dispatch centers.

LIST_ACTIVE_CALLS reads the active/open calls visible for this dispatch center. Infer it semantically from requests about calls on the screen, calls holding, active calls, open calls, or equivalent wording.

Normalize natural status language semantically. Arrived, arriving, on location, on scene, and equivalent wording mean on_scene. Enroute, en route, responding, and equivalent wording mean en_route. If the speaker is enroute to a named active call and is not assigned, return ordered ASSIGN_UNIT then SET_UNIT_STATUS actions.

Use REPORT_FIELD_INCIDENT for urgent first-person field activity. eventType is shots_fired, officer_assist, gunpoint, taserpoint, or fight; note preserves the operational statement. If dialogueContext.kind is field_incident, use UPDATE_FIELD_INCIDENT for answers or supplements: informationType is location, subject_description, direction, weapon, status, or other. Direction, weapon, movement, and status information must be captured even while location or description remains pending.

When an addressed unit with a current call provides an operational observation, movement update, landmark, subject activity, or responding-unit direction, use ADD_CALL_NOTE or REPORT_FIELD_INCIDENT. Do not return NO_ACTION for addressed operational traffic. An urgent officer-assist report from a unit without a current call uses REPORT_FIELD_INCIDENT; execution creates an ASSIST - OFFICER call from verified GPS/location data.

If pendingContext.kind is disposition, a concise reply is the disposition for pendingContext.callId. Return CLEAR_UNIT with that callId, the speaker, and the spoken disposition. If the transmission instead contains new operational information or another command, process it and leave disposition as a later goal.

If exactly one active call safely satisfies an implicit reference, use it. If multiple calls are materially plausible, CLARIFY. Use callRef for natural references such as "the fight" or "the Walmart alarm" when no UUID is known.

For one operation return {"action":"...","confidence":0-1,"input":{},"clarification":null,"reason":"short"}. For multiple operations return {"actions":[{"action":"...","input":{}}],"confidence":0-1,"reason":"short"}. Preserve requested order and include every explicitly requested operation, up to ${MAX_PLAN_ACTIONS}.

CREATE_CALL does not require an assigned unit. Include unitRefs only when assignment was requested. Do not automatically assign the speaker merely because they transmitted.

Action inputs:
SET_UNIT_STATUS={unitRef,status,note?}; CHANGE_UNIT_ZONE={unitRef,zone}; GET_CURRENT_CALL={unitRef}; GET_CALL={callId?|callRef?}; LIST_ACTIVE_CALLS={}; SEARCH_CALLS={query?,callNumber?,address?,nature?,caller?,status?,priority?,unitRef?,dateFrom?,dateTo?};
CREATE_CALL={type,location,apt?,city?,state?,zip?,county?,municipality?,priority?,description?,callerName?,callerPhone?,zone?,latitude?,longitude?,crossStreet1?,crossStreet2?,locationAddressId?,securityClientId?,securityClientSiteId?,unitRefs?}; UPDATE_CALL={callId?|callRef?,type?,location?,apt?,city?,state?,zip?,county?,municipality?,zone?,latitude?,longitude?,crossStreet1?,crossStreet2?,priority?,status?,description?,callerName?,callerPhone?,locationAddressId?,securityClientId?,securityClientSiteId?,disposition?,dispositionNotes?};
ADD_CALL_NOTE={callId?|callRef?,note,unitRef?}; ASSIGN_UNIT={callId?|callRef?,unitRef}; UNASSIGN_UNIT={callId?|callRef?,unitRef}; MAKE_PRIMARY={callId?|callRef?,unitRef}; UPDATE_ASSIGNMENT_TIMES={callId?|callRef?,unitRef,assignedAt?,dispatchedAt?,arrivedAt?,ondtAt?}; CLEAR_UNIT={callId?|callRef?,unitRef,disposition?}; CLOSE_CALL={callId?|callRef?,disposition,unitRefs?,note?};
STATUS_CHECK={unitRef}; REQUEST_BACKUP={unitRef,callId?,location?,priority?,reason?}; REPORT_FIELD_INCIDENT={unitRef,eventType,note,location?,subjectDescription?}; UPDATE_FIELD_INCIDENT={unitRef,informationType,value,note?}; RADIO_CHECK/TIME_CHECK may use {unitRef?}.

Examples: "what calls are on the screen" means LIST_ACTIVE_CALLS. "show me arriving" means SET_UNIT_STATUS on_scene. "Central, I have one running by the Ferris Wheel" means REPORT_FIELD_INCIDENT officer_assist with the complete statement in note. "create a building check at the fair, don't assign anybody" means CREATE_CALL without unitRefs. Do not output prose outside JSON.`;
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
    else if (Array.isArray(value)) result[key] = value.slice(0, 12).map((item) => clean(item, 80)).filter(Boolean);
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  return result;
}

function clean(value, max = 300) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : null;
}
