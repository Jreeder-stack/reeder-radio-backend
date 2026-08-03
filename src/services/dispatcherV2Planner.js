import { getPlannerToolCatalog } from './dispatcherToolRegistry.js';
import { AzureOpenAI } from 'openai';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const SUPPORTED_STATES = new Set([
  'IDLE',
  'AWAITING_COMMAND',
  'AWAITING_CALL_NATURE',
  'AWAITING_CALL_ADDRESS',
  'AWAITING_CALL_CONFIRM',
  'AWAITING_NOTE_CONTENT',
]);
const SUPPORTED_ACTIONS = new Set([
  'NO_ACTION',
  'CLARIFY',
  'RADIO_CHECK',
  'TIME_CHECK',
  'STATUS_CHANGE',
  'CREATE_CALL',
  'ASSIGN_CALL',
  'ADD_NOTE',
  'RUN_PLATE',
  'MY_CALL',
  'CALL_DETAILS',
  'CLEAR_UNIT',
  'CLOSE_CALL',
  'REPEAT',
  'DISREGARD',
  'CONFIRM',
  'DENY',
]);

const VALID_STATUSES = new Set([
  'on_duty',
  'available',
  'en_route',
  'on_scene',
  'off_duty',
  'out_of_service',
]);

const STATE_ABBREVIATIONS = new Map([
  ['ALABAMA', 'AL'], ['ALASKA', 'AK'], ['ARIZONA', 'AZ'], ['ARKANSAS', 'AR'],
  ['CALIFORNIA', 'CA'], ['COLORADO', 'CO'], ['CONNECTICUT', 'CT'], ['DELAWARE', 'DE'],
  ['FLORIDA', 'FL'], ['GEORGIA', 'GA'], ['HAWAII', 'HI'], ['IDAHO', 'ID'],
  ['ILLINOIS', 'IL'], ['INDIANA', 'IN'], ['IOWA', 'IA'], ['KANSAS', 'KS'],
  ['KENTUCKY', 'KY'], ['LOUISIANA', 'LA'], ['MAINE', 'ME'], ['MARYLAND', 'MD'],
  ['MASSACHUSETTS', 'MA'], ['MICHIGAN', 'MI'], ['MINNESOTA', 'MN'], ['MISSISSIPPI', 'MS'],
  ['MISSOURI', 'MO'], ['MONTANA', 'MT'], ['NEBRASKA', 'NE'], ['NEVADA', 'NV'],
  ['NEW HAMPSHIRE', 'NH'], ['NEW JERSEY', 'NJ'], ['NEW MEXICO', 'NM'], ['NEW YORK', 'NY'],
  ['NORTH CAROLINA', 'NC'], ['NORTH DAKOTA', 'ND'], ['OHIO', 'OH'], ['OKLAHOMA', 'OK'],
  ['OREGON', 'OR'], ['PENNSYLVANIA', 'PA'], ['RHODE ISLAND', 'RI'], ['SOUTH CAROLINA', 'SC'],
  ['SOUTH DAKOTA', 'SD'], ['TENNESSEE', 'TN'], ['TEXAS', 'TX'], ['UTAH', 'UT'],
  ['VERMONT', 'VT'], ['VIRGINIA', 'VA'], ['WASHINGTON', 'WA'], ['WEST VIRGINIA', 'WV'],
  ['WISCONSIN', 'WI'], ['WYOMING', 'WY'], ['DISTRICT OF COLUMBIA', 'DC'],
]);

const PROTECTED_EMERGENCY_RX = /\b(officer\s+down|shots?\s+fired|10[-\s/]?33|ten\s+thirty[-\s]?three|emergency\s+traffic|signal\s+100)\b/i;
const DEFAULT_MIN_CONFIDENCE = 0.82;
const DEFAULT_TIMEOUT_MS = 4500;

let client = null;

function cleanString(value, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function cleanArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cleaned = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    if (typeof rawValue === 'string') cleaned[key] = cleanString(rawValue);
    else if (Array.isArray(rawValue)) {
      cleaned[key] = rawValue
        .slice(0, 10)
        .map(item => cleanString(item, 80))
        .filter(Boolean);
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      cleaned[key] = rawValue;
    }
  }

  if (cleaned.status) cleaned.status = String(cleaned.status).toLowerCase().replace(/[\s-]+/g, '_');
  if (cleaned.plate) cleaned.plate = String(cleaned.plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.state) {
    const stateText = String(cleaned.state).toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
    cleaned.state = STATE_ABBREVIATIONS.get(stateText) || (stateText.length === 2 ? stateText : null);
    if (!cleaned.state) delete cleaned.state;
  }
  if (cleaned.targetUnit) cleaned.targetUnit = String(cleaned.targetUnit).toUpperCase().replace(/\s+/g, '-');
  if (cleaned.callNumber) cleaned.callNumber = String(cleaned.callNumber).trim();
  return cleaned;
}

function getMinConfidence() {
  const configured = Number.parseFloat(process.env.AI_DISPATCHER_V2_MIN_CONFIDENCE || '');
  if (Number.isFinite(configured) && configured >= 0.5 && configured <= 1) return configured;
  return DEFAULT_MIN_CONFIDENCE;
}

function getTimeoutMs() {
  const configured = Number.parseInt(process.env.AI_DISPATCHER_V2_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 500 && configured <= 15000) return configured;
  return DEFAULT_TIMEOUT_MS;
}

function getClient() {
  if (!client && isDispatcherV2Configured()) {
    client = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
      apiVersion: '2024-08-01-preview',
    });
  }
  return client;
}

export function isDispatcherV2Enabled() {
  return TRUE_VALUES.has(String(process.env.AI_DISPATCHER_V2_ENABLED || '').trim().toLowerCase());
}

export function isDispatcherV2Configured() {
  return Boolean(
    process.env.AZURE_OPENAI_API_KEY
    && process.env.AZURE_OPENAI_ENDPOINT
    && process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

export function shouldUseDispatcherV2(currentState = 'IDLE') {
  return isDispatcherV2Enabled() && SUPPORTED_STATES.has(String(currentState || '').toUpperCase());
}

export function containsProtectedEmergencyTraffic(transcript) {
  return PROTECTED_EMERGENCY_RX.test(String(transcript || ''));
}

export function validateDispatcherV2Plan(candidate, { minConfidence = getMinConfidence() } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

  const action = String(candidate.action || '').trim().toUpperCase();
  const confidence = Number(candidate.confidence);
  if (!SUPPORTED_ACTIONS.has(action)) return null;
  if (!Number.isFinite(confidence) || confidence < minConfidence || confidence > 1) return null;

  const args = cleanArguments(candidate.arguments);
  const spokenResponse = cleanString(candidate.spokenResponse, 220);
  const clarificationQuestion = cleanString(candidate.clarificationQuestion, 180);
  const reason = cleanString(candidate.reason, 220);

  if (action === 'STATUS_CHANGE' && !VALID_STATUSES.has(args.status)) return null;
  if (action === 'CLARIFY' && !clarificationQuestion && !spokenResponse) return null;
  if (action === 'ADD_NOTE' && !args.noteContent) return null;
  if (action === 'CALL_DETAILS' && !args.callNumber) return null;

  return {
    action,
    confidence,
    arguments: args,
    spokenResponse,
    clarificationQuestion,
    reason,
  };
}

function mergePendingArguments(args, currentState = 'IDLE', currentSlots = {}) {
  const pending = currentSlots && typeof currentSlots === 'object' && !Array.isArray(currentSlots)
    ? currentSlots
    : {};
  const merged = { ...args };
  const routineFields = [
    'nature', 'address', 'priority', 'additionalUnits', 'noteContent',
    'callNumber', 'disposition', 'callNature', 'callLocation', 'callCity',
  ];
  for (const field of routineFields) {
    if ((merged[field] === undefined || merged[field] === null || merged[field] === '')
        && pending[field] !== undefined && pending[field] !== null && pending[field] !== '') {
      merged[field] = pending[field];
    }
  }

  if (currentState === 'AWAITING_NOTE_CONTENT' && !merged.noteContent && merged.note) {
    merged.noteContent = merged.note;
  }
  return merged;
}

function promptForMissingCallField(args) {
  if (!args.nature) return 'What is the call nature?';
  if (!args.address) return 'What is the location?';
  return null;
}

export function mapDispatcherV2PlanToLegacyResult(
  plan,
  unitId = 'Unit',
  currentState = 'IDLE',
  currentSlots = {}
) {
  if (!plan) return { intent: 'UNKNOWN', response: `${unitId}, say again.` };

  const args = mergePendingArguments(
    plan.arguments || {}, currentState, currentSlots
  );
  const response = plan.spokenResponse || null;

  switch (plan.action) {
    case 'NO_ACTION':
      return { intent: 'SILENCE' };
    case 'CLARIFY':
      return { intent: 'UNKNOWN', response: plan.clarificationQuestion || response || `${unitId}, say again.` };
    case 'RADIO_CHECK':
      return { intent: 'RADIO_CHECK', response: response || 'Loud and clear.' };
    case 'TIME_CHECK':
      return { intent: 'TIME_CHECK', response };
    case 'STATUS_CHANGE':
      return {
        intent: 'STATUS_CHANGE',
        cadStatus: args.status,
        response,
        slots: {
          ...(args.callNumber ? { callNumber: args.callNumber } : {}),
          ...(args.callNature ? { callNature: args.callNature } : {}),
          ...(args.callLocation ? { callLocation: args.callLocation } : {}),
          ...(args.callCity ? { callCity: args.callCity } : {}),
        },
      };
    case 'CREATE_CALL': {
      const missingPrompt = promptForMissingCallField(args);
      if (missingPrompt) {
        return {
          intent: 'CREATE_CALL_PROMPT',
          response: plan.clarificationQuestion || response || missingPrompt,
          slots: {
            ...(args.nature ? { nature: args.nature } : {}),
            ...(args.address ? { address: args.address } : {}),
            ...(args.priority ? { priority: args.priority } : {}),
            ...(args.additionalUnits ? { additionalUnits: args.additionalUnits } : {}),
          },
        };
      }
      return {
        intent: 'CREATE_CALL',
        response,
        slots: {
          nature: args.nature,
          address: args.address,
          priority: args.priority || 'medium',
          additionalUnits: args.additionalUnits || [],
        },
      };
    }
    case 'ASSIGN_CALL':
      return {
        intent: 'ASSIGN_CALL',
        response,
        slots: {
          ...(args.callNumber ? { callNumber: args.callNumber } : {}),
          ...(args.callNature ? { callNature: args.callNature } : {}),
          ...(args.callLocation ? { callLocation: args.callLocation } : {}),
          ...(args.callCity ? { callCity: args.callCity } : {}),
        },
      };
    case 'ADD_NOTE':
      return {
        intent: 'ADD_NOTE',
        response,
        slots: {
          noteContent: args.noteContent,
          beAdvised: args.beAdvised === true,
        },
      };
    case 'RUN_PLATE':
      return {
        intent: 'RUN_PLATE',
        response,
        slots: {
          ...(args.plate ? { plate: args.plate } : {}),
          ...(args.state ? { state: args.state } : {}),
        },
      };
    case 'MY_CALL':
      return { intent: 'MY_CALL', response };
    case 'CALL_DETAILS':
      return {
        intent: 'CALL_DETAILS',
        response,
        slots: {
          callNumber: args.callNumber,
          detailField: args.detailField || 'all',
        },
      };
    case 'CLEAR_UNIT':
      return { intent: 'CLEAR_UNIT', response };
    case 'CLOSE_CALL':
      return {
        intent: 'DISPOSE_CALL',
        response,
        slots: {
          ...(args.callNumber ? { callNumber: args.callNumber } : {}),
          ...(args.disposition ? { disposition: args.disposition } : {}),
        },
      };
    case 'REPEAT':
      return { intent: 'REPEAT', response };
    case 'DISREGARD':
      return { intent: 'DISREGARD', response };
    case 'CONFIRM':
      return { intent: 'CONFIRM', response };
    case 'DENY':
      return { intent: 'DENY', response };
    default:
      return { intent: 'UNKNOWN', response: `${unitId}, say again.` };
  }
}

const SYSTEM_PROMPT = `You are the conversational decision engine for a public-safety radio dispatcher.

Understand the field unit's requested outcome from ordinary speech, the current conversation state, pendingData already collected, and the recent radio exchange. Select exactly one supported action for this turn. Do not behave like a phone tree and do not ask for information that is already present in pendingData or recentConversation.

Supported actions:
- NO_ACTION: acknowledgment, unit-to-unit chatter, background speech, or anything not directed to dispatch
- CLARIFY: one genuinely necessary question when the request cannot safely be completed
- RADIO_CHECK
- TIME_CHECK
- STATUS_CHANGE: arguments.status must be one of on_duty, available, en_route, on_scene, off_duty, out_of_service
- CREATE_CALL: arguments may include nature, address, priority, additionalUnits
- ASSIGN_CALL: attach the speaking unit to an existing call; identify it by callNumber or descriptors
- ADD_NOTE: arguments.noteContent contains the actual facts to add to the current or specified call
- RUN_PLATE: arguments may include plate and state
- MY_CALL
- CALL_DETAILS
- CLEAR_UNIT
- CLOSE_CALL
- REPEAT
- DISREGARD
- CONFIRM
- DENY

Conversation rules:
1. currentState and pendingData are authoritative conversation context. Merge the new radio reply with data already collected instead of restarting the workflow.
2. In AWAITING_CALL_ADDRESS, interpret the reply as the missing or corrected location and return CREATE_CALL using the pending nature.
3. In AWAITING_CALL_NATURE, interpret the reply as the missing or corrected call nature and return CREATE_CALL using the pending address.
4. In AWAITING_CALL_CONFIRM, natural approvals such as "that's correct", "10-4", "affirmative", or "go ahead" are CONFIRM. Natural rejections are DENY. If the unit supplies a correction, return CREATE_CALL with the corrected field and all still-valid pending data.
5. In AWAITING_NOTE_CONTENT, preserve the officer's reported facts in arguments.noteContent and return ADD_NOTE.
6. A unit may provide fields out of order, correct an earlier field, or include several facts in one transmission. Use everything available.
7. Never invent a plate, address, call number, disposition, status, unit, incident nature, or CAD result.
8. Do not claim an action succeeded. The server executes and verifies actions after your plan.
9. Ask only one short clarification question, and only when a required fact cannot be resolved from pendingData, recentConversation, CAD lookup, MAI/location lookup, or the current transcript.
10. Pure acknowledgments such as "10-4", "copy", and "roger" are NO_ACTION unless the current state shows the unit is answering a dispatcher question.
11. Do not plan emergency, officer-down, shots-fired, Signal 100, or emergency-traffic actions. Dedicated protected code handles those before this planner.
12. Keep spokenResponse short and natural. It is optional; the executor may replace it after the real CAD result.
13. Confidence below 0.82 should be CLARIFY or NO_ACTION, not a guessed write action.
14. Return JSON only.

The availableTools catalog describes the server-validated capabilities. It is reference material only; never invent a tool outside that catalog.

JSON schema:
{
  "action": "SUPPORTED_ACTION",
  "confidence": 0.0,
  "arguments": {},
  "spokenResponse": "short response or null",
  "clarificationQuestion": "one short question or null",
  "reason": "brief internal reason"
}`;

function filterSlots(currentSlots) {
  if (!currentSlots || typeof currentSlots !== 'object' || Array.isArray(currentSlots)) return {};
  return Object.fromEntries(
    Object.entries(currentSlots)
      .filter(([key]) => !['lastSpokenText', 'conversationHistory', 'lastSearchResult'].includes(key))
      .slice(0, 20)
  );
}

async function callPlannerModel(context) {
  const openai = getClient();
  if (!openai) throw new Error('Azure OpenAI not configured for AI Dispatcher V2');

  const request = openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(context) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 420,
  });

  const timeoutMs = getTimeoutMs();
  let timer;
  try {
    const response = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`AI Dispatcher V2 timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    const content = response?.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI Dispatcher V2 returned an empty response');
    return JSON.parse(content);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function classifyIntentV2(
  transcript,
  unitId,
  currentState = 'IDLE',
  currentSlots = {},
  conversationHistory = []
) {
  if (containsProtectedEmergencyTraffic(transcript)) {
    console.warn(`[AI-DISPATCH-V2] Protected emergency traffic reached routine planner: unit=${unitId}`);
    return {
      intent: 'UNKNOWN',
      response: `${unitId}, repeat emergency traffic.`,
      dispatcherV2: { protectedEmergencyBypass: true },
    };
  }

  const context = {
    unitId,
    currentState,
    pendingData: filterSlots(currentSlots),
    recentConversation: Array.isArray(conversationHistory)
      ? conversationHistory.slice(-3).map(item => ({
          unit: cleanString(item?.unit, 220) || '',
          dispatch: cleanString(item?.dispatch, 220) || '',
        }))
      : [],
    transcript: cleanString(transcript, 700) || '',
    availableTools: getPlannerToolCatalog(),
  };

  const startedAt = Date.now();
  try {
    const candidate = await callPlannerModel(context);
    const plan = validateDispatcherV2Plan(candidate);
    if (!plan) {
      console.warn(`[AI-DISPATCH-V2] Rejected invalid or low-confidence plan: unit=${unitId}, action=${candidate?.action || 'none'}, confidence=${candidate?.confidence ?? 'none'}`);
      return {
        intent: 'UNKNOWN',
        response: `${unitId}, say again.`,
        dispatcherV2: { rejected: true, latencyMs: Date.now() - startedAt },
      };
    }

    const result = mapDispatcherV2PlanToLegacyResult(
      plan, unitId, currentState, currentSlots
    );
    result.dispatcherV2 = {
      action: plan.action,
      confidence: plan.confidence,
      reason: plan.reason,
      latencyMs: Date.now() - startedAt,
    };
    console.log(`[AI-DISPATCH-V2] unit=${unitId} action=${plan.action} confidence=${plan.confidence} latencyMs=${result.dispatcherV2.latencyMs}`);
    return result;
  } catch (error) {
    console.error(`[AI-DISPATCH-V2] Planner failed: unit=${unitId}, error=${error.message}`);
    return {
      intent: 'UNKNOWN',
      response: `${unitId}, say again.`,
      dispatcherV2: { error: error.message, latencyMs: Date.now() - startedAt },
    };
  }
}
