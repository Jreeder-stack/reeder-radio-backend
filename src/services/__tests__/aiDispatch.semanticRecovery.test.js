import { describe, expect, it } from 'vitest';
import {
  shouldAttemptSemanticRecovery,
  validateSemanticRecovery,
} from '../llmIntentService.js';

describe('AI dispatcher semantic recovery', () => {
  it('only retries unknown results in routine conversation states', () => {
    expect(shouldAttemptSemanticRecovery({ intent: 'UNKNOWN' }, 'AWAITING_COMMAND')).toBe(true);
    expect(shouldAttemptSemanticRecovery({ intent: 'OUT_OF_SCOPE' }, 'IDLE')).toBe(true);
    expect(shouldAttemptSemanticRecovery({ intent: 'STATUS_CHANGE' }, 'AWAITING_COMMAND')).toBe(false);
    expect(shouldAttemptSemanticRecovery({ intent: 'UNKNOWN' }, 'AWAITING_PERSON_DOB')).toBe(false);
  });

  it('recovers natural radio-test wording without another phrase script', () => {
    const result = validateSemanticRecovery({
      matched: true,
      intent: 'RADIO_CHECK',
      confidence: 0.96,
      response: 'Your radio is working.',
      slots: {},
    }, 'INDIANA-1');

    expect(result).toMatchObject({
      intent: 'RADIO_CHECK',
      response: 'Loud and clear.',
      semanticRecovery: { accepted: true, confidence: 0.96 },
    });
  });

  it('normalizes a confident paraphrased status change', () => {
    const result = validateSemanticRecovery({
      matched: true,
      intent: 'STATUS_CHANGE',
      confidence: 0.93,
      cadStatus: 'rolling',
      response: 'Copy, rolling.',
      slots: {},
    }, 'INDIANA-1');

    expect(result).toMatchObject({
      intent: 'STATUS_CHANGE',
      cadStatus: 'en_route',
      response: 'Copy, rolling.',
    });
  });

  it('uses existing multi-step handlers when data is missing', () => {
    const plate = validateSemanticRecovery({
      matched: true,
      intent: 'RUN_PLATE',
      confidence: 0.91,
      response: null,
      slots: {},
    }, 'INDIANA-1');

    const call = validateSemanticRecovery({
      matched: true,
      intent: 'CREATE_CALL',
      confidence: 0.9,
      response: null,
      slots: { nature: 'disturbance' },
    }, 'INDIANA-1');

    expect(plate).toMatchObject({ intent: 'RUN_PLATE', slots: {} });
    expect(call).toMatchObject({ intent: 'CREATE_CALL', slots: { nature: 'disturbance' } });
  });

  it('rejects low-confidence or unsupported actions', () => {
    expect(validateSemanticRecovery({
      matched: true,
      intent: 'RADIO_CHECK',
      confidence: 0.55,
    }, 'INDIANA-1')).toBeNull();

    expect(validateSemanticRecovery({
      matched: true,
      intent: 'OFFICER_DOWN',
      confidence: 0.99,
    }, 'INDIANA-1')).toBeNull();
  });

  it('asks for clarification instead of guessing a missing status', () => {
    const result = validateSemanticRecovery({
      matched: true,
      intent: 'STATUS_CHANGE',
      confidence: 0.88,
      cadStatus: null,
      needsClarification: true,
      clarificationQuestion: 'What status do you want?',
    }, 'INDIANA-1');

    expect(result).toMatchObject({
      intent: 'UNKNOWN',
      response: 'What status do you want?',
      semanticRecovery: {
        accepted: true,
        clarification: true,
        proposedIntent: 'STATUS_CHANGE',
      },
    });
  });
});
