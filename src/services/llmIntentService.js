import { AzureOpenAI } from 'openai';
import { classifyIntent as classifyPrimaryIntent } from './llmIntentService.base.js';

export * from './llmIntentService.base.js';

const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;

const DEFAULT_MIN_CONFIDENCE = 0.78;
const DEFAULT_TIMEOUT_MS = 3500;

const RECOVERY_STATES = new Set(['IDLE', 'AWAITING_COMMAND']);
const RECOVERABLE_INTENTS = new Set([
  'RADIO_CHECK',
  'STATUS_CHANGE',
  'RUN_PLATE',
  'CREATE_CALL',
  'TRAFFIC_STOP',
  'REQUEST_BACKUP',
]);

const VALID_CAD_STATUSES = new Set([
  'on_duty',
  'available',
  'en_route',
  'on_scene',
  'off_duty',
  'out_of_service',
]);

const STATUS_ALIASES = new Map([
  ['on duty', 'on_duty'],
  ['in service', 'available'],
  ['10-8', 'available'],
  ['available', 'available'],
  ['en route', 'en_route'],
  ['responding', 'en_route'],
  ['rolling', 'en_route'],
  ['10-76', 'en_route'],
  ['on scene', 'on_scene'],
  ['arrived', 'on_scene'],
  ['10-97', 'on_scene'],
  ['off duty', 'off_duty'],
  ['10-7', 'off_duty'],
  ['out of service', 'out_of_service'],
  ['busy', 'out_of_service'],
  ['10-6', 'out_of_service'],
]);

let recoveryClient = null;

function getRecoveryClient() {
  if (!recoveryClient && AZURE_OPENAI_API_KEY && AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_DEPLOYMENT) {
    recoveryClient = new AzureOpenAI({
      apiKey: AZURE_OPENAI_API_KEY,
      endpoint: AZURE_OPENAI_ENDPOINT,
      deployment: AZURE_OPENAI_DEPLOYMENT,
      apiVersion: '2024-08-01-preview',
    });
  }
  return recoveryClient;
}

function getMinConfidence() {
  const configured = Number.parseFloat(process.env.AI_SEMANTIC_RECOVERY_MIN_CONFIDENCE || '');
  if (Number.isFinite(configured) && configured >= 0 && configured <= 1) return configured;
  return DEFAULT_MIN_CONFIDENCE;
}

function getTimeoutMs() {
  const configured = Number.parseInt(process.env.AI_SEMANTIC_RECOVERY_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 250 && configured <= 15000) return configured;
  return DEFAULT_TIMEOUT_MS;
}

function normalizeIntent(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeCadStatus(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  if (!raw) return null;
  const alias = STATUS_ALIASES.get(raw);
  if (alias) return alias;
  const underscored = raw.replace(/\s+/g, '_');
  return VALID_CAD_STATUSES.has(underscored) ? underscored : null;
}

function cleanSlots(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const slots = { ...value };
  for (const key of Object.keys(slots)) {
    if (slots[key] === undefined || slots[key] === '') delete slots[key];
  }
  if (slots.plate) slots.plate = String(slots.plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return slots;
}

function shortText(value, maxLength = 220) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.slice(0, maxLength);
}

export function shouldAttemptSemanticRecovery(primaryResult, currentState = 'IDLE') {
  if (!RECOVERY_STATES.has(String(currentState || '').toUpperCase())) return false;
  const intent = normalizeIntent(primaryResult?.intent);
  return !intent || intent === 'UNKNOWN' || intent === 'OUT_OF_SCOPE';
}

export function validateSemanticRecovery(candidate, unitId = 'Unknown Unit', minConfidence = getMinConfidence()) {
  if (!candidate || typeof candidate !== 'object' || candidate.matched !== true) return null;

  const intent = normalizeIntent(candidate.intent);
  const confidence = Number(candidate.confidence);
  if (!RECOVERABLE_INTENTS.has(intent)) return null;
  if (!Number.isFinite(confidence) || confidence < minConfidence || confidence > 1) return null;

  const slots = cleanSlots(candidate.slots);
  const response = shortText(candidate.response);
  const clarificationQuestion = shortText(candidate.clarificationQuestion);

  if (intent === 'STATUS_CHANGE') {
    const cadStatus = normalizeCadStatus(candidate.cadStatus || slots.status);
    if (!cadStatus) {
      if (!clarificationQuestion) return null;
      return {
        intent: 'UNKNOWN',
        response: clarificationQuestion,
        semanticRecovery: { accepted: true, clarification: true, proposedIntent: intent, confidence },
      };
    }
    delete slots.status;
    return {
      intent,
      cadStatus,
      slots,
      response: response || `Copy, ${cadStatus.replace(/_/g, ' ')}.`,
      semanticRecovery: { accepted: true, confidence },
    };
  }

  if (intent === 'RADIO_CHECK') {
    return {
      intent,
      response: 'Loud and clear.',
      slots: {},
      semanticRecovery: { accepted: true, confidence },
    };
  }

  if (intent === 'REQUEST_BACKUP') {
    return {
      intent,
      response: response || `${unitId}, copy backup request. Dispatching additional units.`,
      cadAction: 'broadcast',
      cadData: { message: `${unitId} requesting backup`, priority: 'high' },
      slots,
      semanticRecovery: { accepted: true, confidence },
    };
  }

  if (intent === 'TRAFFIC_STOP') {
    return {
      intent,
      response: response || 'Copy.',
      cadStatus: normalizeCadStatus(candidate.cadStatus) || 'on_scene',
      slots,
      semanticRecovery: { accepted: true, confidence },
    };
  }

  if (intent === 'RUN_PLATE') {
    return {
      intent,
      response,
      slots,
      semanticRecovery: { accepted: true, confidence },
    };
  }

  if (intent === 'CREATE_CALL') {
    return {
      intent,
      response,
      slots,
      semanticRecovery: { accepted: true, confidence },
    };
  }

  return null;
}

const RECOVERY_SYSTEM_PROMPT = `You are a narrow semantic recovery classifier for a police radio dispatcher.
The primary classifier already failed. Decide whether the transmission is clearly a natural-language paraphrase of ONE routine supported action.

Supported actions only:
- RADIO_CHECK: a radio/audio test, including phrases like "testing one two three" or "how am I coming through"
- STATUS_CHANGE: the speaking unit changes its own status. cadStatus must be one of on_duty, available, en_route, on_scene, off_duty, out_of_service
- RUN_PLATE: vehicle registration or plate check. Extract a plate when spoken; it may be omitted and the normal handler will ask for it
- CREATE_CALL: create/start a CAD call. Extract nature, address, priority, and additionalUnits only when actually spoken
- TRAFFIC_STOP: the unit reports initiating a traffic stop
- REQUEST_BACKUP: the unit requests another unit or assistance, but not an emergency/distress transmission

Safety rules:
- Do not recover emergencies, officer-down traffic, weapons, pursuits, shots fired, EMS/fire requests, Signal 100, or unclear tactical traffic. Return matched=false; dedicated safety paths handle those.
- Do not invent facts, addresses, plates, call natures, unit IDs, or statuses.
- Do not convert casual conversation, unit-to-unit chatter, or acknowledgments into commands.
- Use confidence >= 0.90 only when the action is unmistakable.
- For an incomplete STATUS_CHANGE, set needsClarification=true and provide a short clarificationQuestion.
- Return only JSON.

Schema:
{
  "matched": true|false,
  "intent": "RADIO_CHECK|STATUS_CHANGE|RUN_PLATE|CREATE_CALL|TRAFFIC_STOP|REQUEST_BACKUP|null",
  "confidence": 0.0-1.0,
  "response": "short radio response or null",
  "cadStatus": "allowed status or null",
  "slots": {},
  "needsClarification": true|false,
  "clarificationQuestion": "short question or null"
}`;

async function callRecoveryModel(transcript, unitId, currentState, currentSlots, conversationHistory) {
  const openai = getRecoveryClient();
  if (!openai) return null;

  const filteredSlots = currentSlots && typeof currentSlots === 'object'
    ? Object.fromEntries(Object.entries(currentSlots).filter(([key]) => !['lastSpokenText', 'conversationHistory', 'lastSearchResult'].includes(key)))
    : {};

  const recentHistory = Array.isArray(conversationHistory)
    ? conversationHistory.slice(-3).map(item => ({ unit: item?.unit || '', dispatch: item?.dispatch || '' }))
    : [];

  const userMessage = JSON.stringify({
    unitId,
    currentState,
    pendingData: filteredSlots,
    recentHistory,
    transcript,
  });

  const request = openai.chat.completions.create({
    model: AZURE_OPENAI_DEPLOYMENT,
    messages: [
      { role: 'system', content: RECOVERY_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 220,
  });

  const timeoutMs = getTimeoutMs();
  let timer;
  try {
    const response = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`semantic recovery timed out after ${timeoutMs}ms`)), timeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);

    const content = response?.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function classifyIntent(transcript, unitId, currentState = 'IDLE', currentSlots = {}, conversationHistory = []) {
  const primaryResult = await classifyPrimaryIntent(transcript, unitId, currentState, currentSlots, conversationHistory);
  if (!shouldAttemptSemanticRecovery(primaryResult, currentState)) return primaryResult;

  console.log(`[LLM-Recovery] Attempting: unit=${unitId}, state=${currentState}, transcript="${transcript}"`);

  try {
    const candidate = await callRecoveryModel(transcript, unitId, currentState, currentSlots, conversationHistory);
    const recovered = validateSemanticRecovery(candidate, unitId);
    if (!recovered) {
      console.log(`[LLM-Recovery] Rejected: unit=${unitId}, candidateIntent=${candidate?.intent || 'none'}, confidence=${candidate?.confidence ?? 'none'}`);
      return primaryResult;
    }

    console.log(`[LLM-Recovery] Accepted: unit=${unitId}, intent=${recovered.intent}, confidence=${recovered.semanticRecovery?.confidence ?? 'n/a'}`);
    return recovered;
  } catch (error) {
    console.warn(`[LLM-Recovery] Failed: unit=${unitId}, error=${error.message}`);
    return primaryResult;
  }
}
