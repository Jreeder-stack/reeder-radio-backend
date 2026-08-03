import {
  classifyIntent as classifyLegacyIntent,
  isConfigured as isLegacyConfigured,
} from './llmIntentService.legacy.js';
import {
  classifyIntentV2,
  isDispatcherV2Configured,
  shouldUseDispatcherV2,
} from './dispatcherV2Planner.js';
import { formatDispatcherTime } from './dispatcherTime.js';
import { resolveNamedPlaceIntent } from './namedPlaceIntentResolver.js';

export * from './llmIntentService.legacy.js';

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
    const result = await classifyIntentV2(
      transcript,
      unitId,
      currentState,
      currentSlots,
      conversationHistory
    );

    // Time is operational data. Never allow the model to invent or estimate it.
    if (result?.intent === 'TIME_CHECK') {
      return {
        ...result,
        response: formatDispatcherTime(),
      };
    }

    return resolveNamedPlaceIntent(result);
  }

  const legacyResult = await classifyLegacyIntent(
    transcript,
    unitId,
    currentState,
    currentSlots,
    conversationHistory
  );
  return resolveNamedPlaceIntent(legacyResult);
}
