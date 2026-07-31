import {
  classifyIntent as classifyLegacyIntent,
  isConfigured as isLegacyConfigured,
} from './llmIntentService.base.js';
import {
  classifyIntentV2,
  isDispatcherV2Configured,
  shouldUseDispatcherV2,
} from './dispatcherV2Planner.js';

export * from './llmIntentService.base.js';

export function isConfigured() {
  return shouldUseDispatcherV2('IDLE')
    ? isDispatcherV2Configured()
    : isLegacyConfigured();
}

export async function classifyIntent(
  transcript,
  unitId,
  currentState = 'IDLE',
  currentSlots = {},
  conversationHistory = []
) {
  if (shouldUseDispatcherV2(currentState)) {
    return classifyIntentV2(
      transcript,
      unitId,
      currentState,
      currentSlots,
      conversationHistory
    );
  }

  return classifyLegacyIntent(
    transcript,
    unitId,
    currentState,
    currentSlots,
    conversationHistory
  );
}
