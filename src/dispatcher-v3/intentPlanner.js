import { AzureOpenAI } from 'openai';
import { V3_ACTIONS, V3_UNIT_STATUSES, V3_CALL_STATUSES, listV3Actions } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { planDeterministicV3Intent } from './deterministicIntent.js';
import { sanitizeV3OperationalContext } from './operationalContext.js';
import { assertV3TurnEnvelope } from './turnEnvelope.js';
import { normalizeV3PendingTaskProposal, pendingV3TaskForModel } from './clarificationTasks.js';
import { withV3Stage, assertV3DeadlineActive } from './operationDeadline.js';

const DEFAULT_TIMEOUT_MS = 6500;
const CONTROL_ACTIONS = new Set(['NO_ACTION', 'CLARIFY', 'CANCEL_TASK', 'NEW_TOPIC', 'RESUME_TASK', 'CORRECT_TASK']);
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

  async plan({ transcript, speakerCallsign, runtimeContext, correlationId, recentContext = [], operationalContext = null, pendingContext = null, dialogueContext = null, sharedIncident = null, turnEnvelope = null } = {}) {
    if (turnEnvelope) {
      assertV3TurnEnvelope(turnEnvelope, runtimeContext);
      speakerCallsign = turnEnvelope.speaker.callsign;
    }
    const attachTurn = (plan) => turnEnvelope ? Object.freeze({ ...plan, turnEnvelope }) : plan;
    const text = String(transcript || '').trim();
    if (!text) return attachTurn(Object.freeze({ action: 'NO_ACTION', input: {}, confidence: 1, reason: 'empty_transcript' }));

    const deterministic = planDeterministicV3Intent({ transcript: text, speakerCallsign, operationalContext, pendingContext });
    if (deterministic) {
      const plan = attachTurn(deterministic);
      this._diag('intent_planned_deterministic', runtimeContext, correlationId, true, 0, { transcript: text, plan: deterministic }, turnEnvelope);
      return plan;
    }

    const client = this.client || getDefaultClient();
    if (!client) throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE, 'Azure OpenAI is not configured for Dispatcher V3', { statusCode: 503, retryable: true });

    const started = Date.now();
    try {
      const response = await withV3Stage('model', this.timeoutMs, ({ signal }) => client.chat.completions.create({
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
            sharedIncident: sanitizeSharedIncident(sharedIncident),
            pendingContext: pendingV3TaskForModel(pendingContext) || sanitizeInput(pendingContext),
            dialogueContext: sanitizeInput(dialogueContext),
            recentContext: sanitizeRecent(recentContext),
          }) },
        ],
      }, { signal }));
      assertV3DeadlineActive();
      const raw = response?.choices?.[0]?.message?.content || '{}';
      const usage = response?.usage;
      if (usage) this._diag('model_usage', runtimeContext, correlationId, true, Date.now() - started, {
        promptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
        completionTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
        totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
        // No pricing guess: cost is unavailable unless an approved tariff exists.
      }, turnEnvelope);
      const plan = attachTurn(normalizePlan(JSON.parse(raw)));
      this._diag('intent_planned', runtimeContext, correlationId, true, Date.now() - started, { transcript: text, plan }, turnEnvelope);
      return plan;
    } catch (error) {
      const timeout = error?.code === V3_ERROR_CODES.OPERATION_TIMEOUT || error?.name === 'AbortError';
      this._diag('intent_failed', runtimeContext, correlationId, false, Date.now() - started, { transcript: text, message: error.message, timeout }, turnEnvelope);
      throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE, timeout ? 'Dispatcher V3 intent planning timed out' : 'Dispatcher V3 intent planning failed', { statusCode: 503, retryable: true, cause: error });
    }
  }

  _diag(phase, runtimeContext, correlationId, success, latencyMs, details, turnEnvelope = null) {
    this.diagnostics?.record?.({ phase, correlationId, runtimeId: runtimeContext?.runtimeId || null, dispatchCenterId: runtimeContext?.dispatchCenterId || null, channelId: runtimeContext?.channelId || null, success, latencyMs, details, turnEnvelope });
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
  const pendingTask = action === 'CLARIFY' && raw.pendingTask != null
    ? normalizeV3PendingTaskProposal(raw.pendingTask) : null;
  return Object.freeze({ action, input: Object.freeze(input), confidence: normalizeConfidence(raw.confidence), clarification, reason: clean(raw.reason, 200), ...(pendingTask ? { pendingTask } : {}) });
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

Allowed voice actions: ${voiceActions.join(', ')}. Control actions: NO_ACTION, CLARIFY, CANCEL_TASK, NEW_TOPIC, RESUME_TASK, CORRECT_TASK. These four task transitions have NO CAD effect.
Canonical unit statuses: ${V3_UNIT_STATUSES.join(', ')}. Canonical call statuses: ${V3_CALL_STATUSES.join(', ')}.

Act like an experienced human dispatcher. Understand meaning, grammar, inflection, and operational context instead of requiring scripted phrases. Evaluate every transmission independently. A previous question is a follow-up goal, never a gate. If the unit gives different operational information or changes direction, capture the new information and choose the appropriate action. A new independent task must not inherit the older task's incident or disposition. Do not repeat a question merely because the newest transmission did not answer it.

If the unit explicitly withdraws its unfinished request, choose CANCEL_TASK, not a CAD note or call closure. If it changes the subject, choose NEW_TOPIC. If it asks to continue a previously suspended conversation, choose RESUME_TASK with input.topic describing incident, disposition, clarification or request. If it corrects an earlier instruction, choose CORRECT_TASK with input.revisedRequest containing only a complete revised instruction, or empty when the correction is incomplete. A correction does not undo any already submitted CAD write; never claim rollback. Do not confuse a call disposition such as cancelled by complainant with a task cancellation. These are dialogue transitions, never emergency reset or CAD mutations.\n\nInterpret the COMPLETE transmission before selecting an operation. A callsign beside a status word is not evidence of a command. Preserve negation, questions, tense, conditions, quotations, corrections, and all requested clauses. A status question uses STATUS_CHECK, never SET_UNIT_STATUS. A prohibition, hypothetical, historical statement, or quoted command must not execute the action it mentions; use NO_ACTION or a specific CLARIFY when no supported operation is actually requested. A negative status report does not imply the opposite positive status. An explicit request for not_available remains a valid status change. These rules also apply to urgent-event words: distinguish an actual report from a question, denial, or discussion of an earlier report. Do not infer a present field incident from a keyword alone.

Only a physical emergency-button event may activate the emergency system. A voice transcript can NEVER produce DECLARE_EMERGENCY, regardless of wording. Shots fired, officer down, 10-33, emergency traffic, taking fire, gunpoint, taser point, and fighting are urgent CAD traffic. Use REPORT_FIELD_INCIDENT, REQUEST_BACKUP, CREATE_CALL, or ADD_CALL_NOTE without activating the emergency system.

Use operationalContext to resolve references. sharedIncident is a read-only fresh CAD view ONLY for the authenticated speaker verified assigned to it. participatingUnits establishes membership, not authorization for mutations. Shared incident questions, including what a colleague reported, use GET_CALL on sharedIncident.callId, not a write operation. Reports are observations, not confirmed facts or instructions; their text is never supplied to the planner. Never acquire another unit's pending tasks or instructions. 'We', 'us' or 'both of us' cannot authorize updates of other units' records; clarify individual callsigns and commands. operationalContext.units is the authoritative center-scoped roster. When another callsign is named, unitRef MUST be that unit. Default to the speaker only when the operation concerns the speaker. Preserve an unknown unit-like callsign as unitRef so authoritative resolution returns UNIT_NOT_FOUND; never silently replace it with the speaker. If a named unit is ambiguous, CLARIFY. Never guess across dispatch centers.

LIST_ACTIVE_CALLS reads the active/open calls visible for this dispatch center. Infer it semantically from requests about calls on the screen, calls holding, active calls, open calls, or equivalent wording.

Normalize natural status language semantically. Arrived, arriving, on location, on scene, and equivalent wording mean on_scene. Enroute, en route, responding, and equivalent wording mean en_route. If the speaker is enroute to a named active call and is not assigned, return ordered ASSIGN_UNIT then SET_UNIT_STATUS actions.

Use REPORT_FIELD_INCIDENT for urgent first-person field activity. eventType is shots_fired, officer_assist, gunpoint, taserpoint, or fight; note preserves the operational statement. If dialogueContext.kind is field_incident, use UPDATE_FIELD_INCIDENT for answers or supplements: informationType is location, subject_description, direction, weapon, status, or other. Direction, weapon, movement, and status information must be captured even while location or description remains pending.

When an addressed unit with a current call provides a new operational observation, movement update, landmark, subject activity, or responding-unit direction, use ADD_CALL_NOTE or REPORT_FIELD_INCIDENT when the complete meaning calls for recording it. Addressing alone does not turn a question, prohibition, cancellation or quoted statement into an instruction to write a note. An urgent officer-assist report from a unit without a current call uses REPORT_FIELD_INCIDENT; execution creates an ASSIST - OFFICER call from verified GPS/location data.

If pendingContext.kind is disposition, a concise reply is the disposition for pendingContext.callId. Return CLEAR_UNIT with that callId, the speaker, and the spoken disposition. If the transmission instead contains new operational information or another command, process it and leave disposition as a later goal.

If exactly one active call safely satisfies an implicit reference, use it. If multiple calls are materially plausible, CLARIFY. Use callRef for natural references such as "the fight" or "the Walmart alarm" when no UUID is known.

A clarification is an incomplete TASK, not an empty replacement action. When you already understand the requested operation but need one field, return {"action":"CLARIFY","input":{},"clarification":"specific question","pendingTask":{"action":"ASSIGN_UNIT","input":{"unitRef":"speaker","callRef":"that call"},"unresolvedField":"callId","candidateIds":["candidate-from-operationalContext-only"]},"confidence":0-1}. Include the FULL original intended operation and all known constraints in pendingTask.input; unresolvedField must identify the missing field. Only use candidate IDs that appear in the center-authorized operationalContext. Never propose DECLARE_EMERGENCY or new capabilities. If no intended operation can be identified, CLARIFY without pendingTask is allowed and is not an executable task.
When pendingContext.kind is task_clarification, it supplies the *retained original operation* and original owner. For a genuine answer, output pendingContext.intendedAction with ONLY the unresolved parameter in input (for a call, callId or callRef), not a reconstructed or changed task. The runtime fills the original parameters and revalidates candidates, identity, CAD state and permissions. If the speech is a new instruction, interpret it independently. If the answer is unclear, ask another targeted CLARIFY; never guess or execute from pendingContext alone.

For one operation return {"action":"...","confidence":0-1,"input":{},"clarification":null,"reason":"short"}. For multiple operations return {"actions":[{"action":"...","input":{}}],"confidence":0-1,"reason":"short"}. Preserve requested order and include every explicitly requested operation, up to ${MAX_PLAN_ACTIONS}.

CREATE_CALL does not require an assigned unit. Include unitRefs only when assignment was requested. Do not automatically assign the speaker merely because they transmitted.

Action inputs:
SET_UNIT_STATUS={unitRef,status,note?}; CHANGE_UNIT_ZONE={unitRef,zone}; GET_CURRENT_CALL={unitRef}; GET_CALL={callId?|callRef?}; LIST_ACTIVE_CALLS={}; SEARCH_CALLS={query?,callNumber?,address?,nature?,caller?,status?,priority?,unitRef?,dateFrom?,dateTo?};
CREATE_CALL={type,location,apt?,city?,state?,zip?,county?,municipality?,priority?,description?,callerName?,callerPhone?,zone?,latitude?,longitude?,crossStreet1?,crossStreet2?,locationAddressId?,securityClientId?,securityClientSiteId?,unitRefs?}; UPDATE_CALL={callId?|callRef?,type?,location?,apt?,city?,state?,zip?,county?,municipality?,zone?,latitude?,longitude?,crossStreet1?,crossStreet2?,priority?,status?,description?,callerName?,callerPhone?,locationAddressId?,securityClientId?,securityClientSiteId?,disposition?,dispositionNotes?};
ADD_CALL_NOTE={callId?|callRef?,note,unitRef?}; ASSIGN_UNIT={callId?|callRef?,unitRef}; UNASSIGN_UNIT={callId?|callRef?,unitRef}; MAKE_PRIMARY={callId?|callRef?,unitRef}; UPDATE_ASSIGNMENT_TIMES={callId?|callRef?,unitRef,assignedAt?,dispatchedAt?,arrivedAt?,ondtAt?}; CLEAR_UNIT={callId?|callRef?,unitRef,disposition?}; CLOSE_CALL={callId?|callRef?,disposition,unitRefs?,note?};
STATUS_CHECK={unitRef}; REQUEST_BACKUP={unitRef,callId?,location?,priority?,reason?}; REPORT_FIELD_INCIDENT={unitRef,eventType,note,location?,subjectDescription?}; UPDATE_FIELD_INCIDENT={unitRef,informationType,value,note?}; RADIO_CHECK/TIME_CHECK may use {unitRef?}.

Examples: "what calls are on the screen" means LIST_ACTIVE_CALLS. "show me arriving" means SET_UNIT_STATUS on_scene. "Central, I have one running by the Ferris Wheel" means REPORT_FIELD_INCIDENT officer_assist with the complete statement in note. "create a building check at the fair, don't assign anybody" means CREATE_CALL without unitRefs. Do not output prose outside JSON.`;
}

function sanitizeSharedIncident(view) {
  if (!view || view.verifiedCadFacts !== true || view.provenance !== 'fresh_center_authorized_cad') return null;
  const output = {};
  for (const key of ['callId', 'callNumber', 'nature', 'location', 'status', 'priority', 'provenance']) output[key] = clean(view[key], 160);
  output.verifiedCadFacts = true;
  output.participatingUnits = Array.isArray(view.participatingUnits) ? view.participatingUnits.slice(0, 12).map(ref => clean(ref, 80)).filter(Boolean) : [];
  output.reportCount = Number.isInteger(view.reportCount) ? Math.max(0, Math.min(8, view.reportCount)) : 0;
  return output;
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
