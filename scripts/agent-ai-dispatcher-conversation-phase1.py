from pathlib import Path
import re

planner_path = Path('src/services/dispatcherV2Planner.js')
planner = planner_path.read_text()

if "getPlannerToolCatalog" not in planner:
    planner = "import { getPlannerToolCatalog } from './dispatcherToolRegistry.js';\n" + planner

planner, count = re.subn(
    r"const SUPPORTED_STATES = new Set\(\['IDLE', 'AWAITING_COMMAND'\]\);",
    "const SUPPORTED_STATES = new Set([\n"
    "  'IDLE',\n"
    "  'AWAITING_COMMAND',\n"
    "  'AWAITING_CALL_NATURE',\n"
    "  'AWAITING_CALL_ADDRESS',\n"
    "  'AWAITING_CALL_CONFIRM',\n"
    "  'AWAITING_NOTE_CONTENT',\n"
    "]);",
    planner,
)
if count != 1:
    raise SystemExit(f'Expected one SUPPORTED_STATES replacement, found {count}')

planner, count = re.subn(
    r"  'DISREGARD',\n\]\);",
    "  'DISREGARD',\n  'CONFIRM',\n  'DENY',\n]);",
    planner,
    count=1,
)
if count != 1:
    raise SystemExit(f'Expected one SUPPORTED_ACTIONS replacement, found {count}')

marker = "function promptForMissingCallField(args) {\n"
helper = """function mergePendingArguments(args, currentState = 'IDLE', currentSlots = {}) {
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

"""
if helper.strip() not in planner:
    planner = planner.replace(marker, helper + marker, 1)

planner = planner.replace(
    "export function mapDispatcherV2PlanToLegacyResult(plan, unitId = 'Unit') {",
    "export function mapDispatcherV2PlanToLegacyResult(\n  plan,\n  unitId = 'Unit',\n  currentState = 'IDLE',\n  currentSlots = {}\n) {",
    1,
)
planner = planner.replace(
    "  const args = plan.arguments || {};\n  const response = plan.spokenResponse || null;",
    "  const args = mergePendingArguments(\n    plan.arguments || {}, currentState, currentSlots\n  );\n  const response = plan.spokenResponse || null;",
    1,
)

planner = planner.replace(
    "    case 'DISREGARD':\n      return { intent: 'DISREGARD', response };\n    default:",
    "    case 'DISREGARD':\n      return { intent: 'DISREGARD', response };\n"
    "    case 'CONFIRM':\n      return { intent: 'CONFIRM', response };\n"
    "    case 'DENY':\n      return { intent: 'DENY', response };\n"
    "    default:",
    1,
)

system_prompt = r"""const SYSTEM_PROMPT = `You are the conversational decision engine for a public-safety radio dispatcher.

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
}`;"""
planner, count = re.subn(
    r"const SYSTEM_PROMPT = `.*?`;\n\nfunction filterSlots",
    system_prompt + "\n\nfunction filterSlots",
    planner,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit(f'Expected one SYSTEM_PROMPT replacement, found {count}')

planner = planner.replace(
    "    transcript: cleanString(transcript, 700) || '',\n  };",
    "    transcript: cleanString(transcript, 700) || '',\n"
    "    availableTools: getPlannerToolCatalog(),\n"
    "  };",
    1,
)
planner = planner.replace(
    "    const result = mapDispatcherV2PlanToLegacyResult(plan, unitId);",
    "    const result = mapDispatcherV2PlanToLegacyResult(\n"
    "      plan, unitId, currentState, currentSlots\n"
    "    );",
    1,
)
planner = planner.replace("    max_tokens: 260,", "    max_tokens: 420,", 1)
planner_path.write_text(planner)

service_path = Path('src/services/aiDispatchService.js')
service = service_path.read_text()
patterns = [
    r"\n      if \(state === DISPATCHER_STATE\.AWAITING_CALL_NATURE\) \{.*?\n      \}\n",
    r"\n      if \(state === DISPATCHER_STATE\.AWAITING_CALL_ADDRESS\) \{.*?\n      \}\n",
    r"\n      if \(state === DISPATCHER_STATE\.AWAITING_CALL_CONFIRM\) \{.*?\n      \}\n",
    r"\n      if \(state === DISPATCHER_STATE\.AWAITING_NOTE_CONTENT\) \{.*?\n      \}\n",
]
for pattern in patterns:
    service, count = re.subn(pattern, "\n", service, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'Expected one AI follow-up fast-path removal for {pattern}, found {count}')
service_path.write_text(service)

test_path = Path('src/services/dispatcherV2Conversation.test.js')
test_path.write_text("""import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mapDispatcherV2PlanToLegacyResult,
  shouldUseDispatcherV2,
  validateDispatcherV2Plan,
} from './dispatcherV2Planner.js';

describe('AI Dispatcher V2 conversational follow-up routing', () => {
  const originalFlag = process.env.AI_DISPATCHER_V2_ENABLED;

  beforeEach(() => {
    process.env.AI_DISPATCHER_V2_ENABLED = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AI_DISPATCHER_V2_ENABLED;
    else process.env.AI_DISPATCHER_V2_ENABLED = originalFlag;
  });

  it('keeps AI enabled while waiting for routine follow-up information', () => {
    expect(shouldUseDispatcherV2('AWAITING_CALL_ADDRESS')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_CALL_NATURE')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_CALL_CONFIRM')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_NOTE_CONTENT')).toBe(true);
  });

  it('merges a newly supplied address with the pending call nature', () => {
    const plan = validateDispatcherV2Plan({
      action: 'CREATE_CALL',
      confidence: 0.98,
      arguments: { address: 'Fayette County Fair, Dunbar, PA' },
    });
    const result = mapDispatcherV2PlanToLegacyResult(
      plan,
      'INDIANA-1',
      'AWAITING_CALL_ADDRESS',
      { nature: 'BUILDING CHECK', priority: 'medium', additionalUnits: [] },
    );
    expect(result).toMatchObject({
      intent: 'CREATE_CALL',
      slots: {
        nature: 'BUILDING CHECK',
        address: 'Fayette County Fair, Dunbar, PA',
        priority: 'medium',
      },
    });
  });

  it('merges a newly supplied nature with the pending address', () => {
    const plan = validateDispatcherV2Plan({
      action: 'CREATE_CALL',
      confidence: 0.98,
      arguments: { nature: 'building check' },
    });
    const result = mapDispatcherV2PlanToLegacyResult(
      plan,
      'INDIANA-1',
      'AWAITING_CALL_NATURE',
      { address: '132 Pechin Road, Dunbar, PA', priority: 'medium' },
    );
    expect(result).toMatchObject({
      intent: 'CREATE_CALL',
      slots: {
        nature: 'building check',
        address: '132 Pechin Road, Dunbar, PA',
      },
    });
  });

  it('maps natural confirmation decisions back to guarded handlers', () => {
    const confirm = validateDispatcherV2Plan({ action: 'CONFIRM', confidence: 0.99, arguments: {} });
    const deny = validateDispatcherV2Plan({ action: 'DENY', confidence: 0.99, arguments: {} });
    expect(mapDispatcherV2PlanToLegacyResult(confirm, 'INDIANA-1')).toMatchObject({ intent: 'CONFIRM' });
    expect(mapDispatcherV2PlanToLegacyResult(deny, 'INDIANA-1')).toMatchObject({ intent: 'DENY' });
  });

  it('turns a free-form follow-up into a real call note', () => {
    const plan = validateDispatcherV2Plan({
      action: 'ADD_NOTE',
      confidence: 0.97,
      arguments: { noteContent: 'Rear loading door was found unsecured and has been secured.' },
    });
    expect(mapDispatcherV2PlanToLegacyResult(
      plan,
      'INDIANA-1',
      'AWAITING_NOTE_CONTENT',
      {},
    )).toMatchObject({
      intent: 'ADD_NOTE',
      slots: { noteContent: 'Rear loading door was found unsecured and has been secured.' },
    });
  });
});
""")

docs_path = Path('docs/AI_DISPATCHER_V2.md')
if docs_path.exists():
    docs = docs_path.read_text()
    note = """

## Conversational follow-up migration — phase 1

When V2 is enabled, AI now remains in control while collecting a call nature, call location, call confirmation, or note content. Pending fields are supplied to the planner as conversation context, so officers may answer naturally, provide fields out of order, or correct an earlier field without restarting a rigid script. Emergency traffic and the actual CAD write/confirmation handlers remain deterministic.
"""
    if 'Conversational follow-up migration — phase 1' not in docs:
        docs_path.write_text(docs.rstrip() + note + '\n')
