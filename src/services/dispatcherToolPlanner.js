import { AzureOpenAI } from 'openai';
import {
  getPlannerToolCatalog,
  getDispatcherTool,
  validateDispatcherToolArguments,
} from './dispatcherToolRegistry.js';

const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;

const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_MIN_CONFIDENCE = 0.70;
const MAX_TRANSCRIPT_LENGTH = 600;

const SAFETY_CRITICAL_RX = /\b(officer\s+down|shots?\s+fired|gun\s*point|weapon|armed|10[-\s/]?33|ten\s+thirty[-\s]?three|foot\s+pursuit|vehicle\s+pursuit|in\s+pursuit|hostage|fight\s+in\s+progress|need\s+ems|request\s+ems|send\s+ems|need\s+fire|request\s+fire|send\s+fire|signal\s+100)\b/i;

const EXISTING_INTENT_TOOL_MAP = new Map([
  ['RADIO_CHECK', 'radio_check'],
  ['TIME_CHECK', 'time_check'],
  ['STATUS_CHANGE', 'update_unit_status'],
  ['STATUS_CHANGE_OTHER', 'update_unit_status'],
  ['CREATE_CALL', 'create_call'],
  ['CREATE_CALL_PROMPT', 'create_call'],
  ['ASSIGN_CALL', 'assign_unit_to_call'],
  ['ASSIGN_OTHER_UNIT', 'assign_unit_to_call'],
  ['ADD_NOTE', 'add_call_note'],
  ['LOG_EVENT_NOTE', 'add_call_note'],
  ['RUN_PLATE', 'run_plate'],
  ['PERSON_CHECK_DETAILS', 'run_person'],
  ['PERSON_CHECK_DL', 'run_person'],
  ['PERSON_CHECK_SSN', 'run_person'],
  ['QUERY_CALLS', 'query_pending_calls'],
  ['MY_CALL', 'get_unit_assignment'],
  ['CALL_DETAILS', 'get_call_details'],
  ['CLEAR_UNIT', 'clear_unit'],
  ['DISPOSE_CALL', 'close_call'],
  ['CANCEL_CALL', 'cancel_call'],
  ['REQUEST_BACKUP', 'request_backup'],
]);

let plannerClient = null;

function getPlannerClient() {
  if (!plannerClient && isToolPlannerConfigured()) {
    plannerClient = new AzureOpenAI({
      apiKey: AZURE_OPENAI_API_KEY,
      endpoint: AZURE_OPENAI_ENDPOINT,
      deployment: AZURE_OPENAI_DEPLOYMENT,
      apiVersion: '2024-08-01-preview',
    });
  }
  return plannerClient;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(String(value).trim().toLowerCase());
}

function getTimeoutMs() {
  const configured = Number.parseInt(process.env.AI_DISPATCH_TOOL_SHADOW_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 250 && configured <= 15000) return configured;
  return DEFAULT_TIMEOUT_MS;
}

function getMinConfidence() {
  const configured = Number.parseFloat(process.env.AI_DISPATCH_TOOL_SHADOW_MIN_CONFIDENCE || '');
  if (Number.isFinite(configured) && configured >= 0 && configured <= 1) return configured;
  return DEFAULT_MIN_CONFIDENCE;
}

function shortText(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, maxLength) : null;
}

function safeStateSlots(slots) {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return {};
  const excluded = new Set(['conversationHistory', 'lastSpokenText', 'lastSearchResult']);
  return Object.fromEntries(
    Object.entries(slots)
      .filter(([key, value]) => !excluded.has(key) && value !== undefined)
      .slice(0, 20),
  );
}

export function isToolPlannerConfigured() {
  return !!(AZURE_OPENAI_API_KEY && AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_DEPLOYMENT);
}

export function isToolPlannerShadowEnabled() {
  return parseBoolean(process.env.AI_DISPATCH_TOOL_SHADOW_ENABLED, true);
}

export function containsSafetyCriticalTraffic(transcript) {
  return SAFETY_CRITICAL_RX.test(String(transcript || ''));
}

export function mapExistingIntentToTool(existingResult) {
  const intent = String(existingResult?.intent || '').trim().toUpperCase();
  return EXISTING_INTENT_TOOL_MAP.get(intent) || null;
}

export function compareShadowPlan(existingResult, shadowPlan) {
  const existingTool = mapExistingIntentToTool(existingResult);
  const proposedTool = shadowPlan?.tool || null;
  let outcome = 'unmapped';
  if (!existingTool && !proposedTool) outcome = 'both_no_action';
  else if (!existingTool && proposedTool) outcome = 'planner_only';
  else if (existingTool && !proposedTool) outcome = 'existing_only';
  else if (existingTool === proposedTool) outcome = 'agreement';
  else outcome = 'disagreement';
  return { existingTool, proposedTool, outcome };
}

export function validateShadowToolPlan(candidate, { unitId, minConfidence = getMinConfidence() } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

  const rawTool = candidate.tool === null ? null : String(candidate.tool || '').trim();
  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  if (!rawTool) {
    return {
      tool: null,
      arguments: {},
      confidence,
      missingFields: [],
      needsClarification: false,
      clarificationQuestion: null,
      reason: shortText(candidate.reason),
      executable: false,
      shadowOnly: true,
    };
  }

  const tool = getDispatcherTool(rawTool);
  if (!tool || confidence < minConfidence) return null;

  const suppliedArgs = candidate.arguments && typeof candidate.arguments === 'object'
    ? { ...candidate.arguments }
    : {};
  if (unitId && ['update_unit_status', 'get_unit_assignment', 'clear_unit', 'request_backup'].includes(rawTool) && !suppliedArgs.unitId) {
    suppliedArgs.unitId = unitId;
  }

  const validation = validateDispatcherToolArguments(rawTool, suppliedArgs, candidate.missingFields);
  const needsClarification = candidate.needsClarification === true || validation.missingFields.length > 0;
  const clarificationQuestion = shortText(candidate.clarificationQuestion);
  if (needsClarification && !clarificationQuestion) return null;
  if (!needsClarification && !validation.valid) return null;

  return {
    tool: rawTool,
    arguments: validation.arguments,
    confidence,
    missingFields: validation.missingFields,
    needsClarification,
    clarificationQuestion,
    reason: shortText(candidate.reason),
    executable: false,
    shadowOnly: true,
    risk: tool.risk,
    confirmationRequired: tool.confirmationRequired,
  };
}

const PLANNER_SYSTEM_PROMPT = `You are a shadow-mode police CAD dispatcher tool planner.
You independently interpret one radio transmission and propose at most one trusted tool from the supplied catalog.

CRITICAL:
- You are OBSERVATION ONLY. Never claim an action was executed.
- Return tool=null for acknowledgments, chatter, ambiguous audio, or anything outside the catalog.
- Return tool=null for emergencies, officer-down traffic, pursuits, weapons, shots fired, EMS/fire requests, Signal 100, or tactical distress traffic. Dedicated deterministic safety code handles those.
- Never invent a unit, call number, plate, person, address, disposition, status, or note.
- The speaking unitId may be used when the requested action concerns that same unit.
- When a tool is clear but required information is missing, select the tool, list missingFields, set needsClarification=true, and ask one short radio clarification question.
- Confidence represents confidence in the proposed tool, not speech-recognition quality.
- Return JSON only.

Output schema:
{
  "tool": "catalog tool name or null",
  "arguments": {},
  "confidence": 0.0,
  "missingFields": [],
  "needsClarification": false,
  "clarificationQuestion": null,
  "reason": "brief explanation"
}`;

function buildPlannerUserMessage({ transcript, unitId, currentState, currentSlots, conversationHistory }) {
  const recentHistory = Array.isArray(conversationHistory)
    ? conversationHistory.slice(-3).map(exchange => ({
        unit: shortText(exchange?.unit, 160) || '',
        dispatch: shortText(exchange?.dispatch, 160) || '',
      }))
    : [];

  return JSON.stringify({
    toolCatalog: getPlannerToolCatalog(),
    context: {
      unitId,
      currentState,
      pendingData: safeStateSlots(currentSlots),
      recentHistory,
      transcript: String(transcript || '').slice(0, MAX_TRANSCRIPT_LENGTH),
    },
  });
}

async function callPlannerModel(context) {
  const openai = getPlannerClient();
  if (!openai) return null;

  const request = openai.chat.completions.create({
    model: AZURE_OPENAI_DEPLOYMENT,
    messages: [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: buildPlannerUserMessage(context) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.05,
    max_tokens: 300,
  });

  const timeoutMs = getTimeoutMs();
  let timer;
  try {
    const response = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`tool shadow planner timed out after ${timeoutMs}ms`)), timeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
    const content = response?.choices?.[0]?.message?.content;
    return content ? JSON.parse(content) : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emitShadowLog(payload) {
  console.log(`[AI-TOOL-SHADOW] ${JSON.stringify(payload)}`);
}

export async function planDispatcherToolShadow(context) {
  const startedAt = Date.now();
  const baseLog = {
    unitId: context?.unitId || null,
    state: context?.currentState || null,
    transcript: String(context?.transcript || '').slice(0, MAX_TRANSCRIPT_LENGTH),
    existingIntent: context?.existingResult?.intent || null,
    semanticRecovery: context?.existingResult?.semanticRecovery || null,
    executed: false,
    mode: 'shadow',
  };

  if (!isToolPlannerShadowEnabled()) {
    const result = { ...baseLog, status: 'disabled', latencyMs: Date.now() - startedAt };
    emitShadowLog(result);
    return result;
  }
  if (!isToolPlannerConfigured()) {
    const result = { ...baseLog, status: 'not_configured', latencyMs: Date.now() - startedAt };
    emitShadowLog(result);
    return result;
  }
  if (containsSafetyCriticalTraffic(context?.transcript)) {
    const result = { ...baseLog, status: 'safety_path_skipped', latencyMs: Date.now() - startedAt };
    emitShadowLog(result);
    return result;
  }

  try {
    const candidate = await callPlannerModel(context);
    const plan = validateShadowToolPlan(candidate, { unitId: context?.unitId });
    const comparison = compareShadowPlan(context?.existingResult, plan);
    const result = {
      ...baseLog,
      status: plan ? 'planned' : 'rejected',
      plan,
      comparison,
      candidate: plan ? undefined : {
        tool: candidate?.tool ?? null,
        confidence: candidate?.confidence ?? null,
        reason: shortText(candidate?.reason),
      },
      latencyMs: Date.now() - startedAt,
    };
    emitShadowLog(result);
    return result;
  } catch (error) {
    const result = {
      ...baseLog,
      status: 'error',
      error: shortText(error?.message || 'unknown error'),
      latencyMs: Date.now() - startedAt,
    };
    emitShadowLog(result);
    return result;
  }
}

export function scheduleDispatcherToolShadow(context) {
  if (!isToolPlannerShadowEnabled()) return;
  const timer = setTimeout(() => {
    void planDispatcherToolShadow(context).catch(error => {
      console.warn(`[AI-TOOL-SHADOW] Unhandled planner error: ${error.message}`);
    });
  }, 0);
  if (timer.unref) timer.unref();
}
