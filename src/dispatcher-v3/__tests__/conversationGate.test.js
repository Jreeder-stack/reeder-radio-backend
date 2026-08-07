import { describe, expect, it } from 'vitest';
import { V3ConversationGate } from '../conversationGate.js';

describe('V3ConversationGate', () => {
  it('ignores unrelated channel traffic', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Indiana 2 switch to tac' })).toMatchObject({ allowed: false, reason: 'not_addressed' });
  });

  it('accepts and strips an addressed transmission', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Central, show me en route' })).toMatchObject({ allowed: true, reason: 'wake_word', transcript: 'show me en route' });
  });

  it('accepts a timed follow-up without another wake word', () => {
    let now = 1000;
    const gate = new V3ConversationGate({ wakeWords: ['central'], pendingMs: 30000, now: () => now });
    gate.expectFollowUp('INDIANA-1', { clarification: 'What location?' });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Fayette County Fair' })).toMatchObject({ allowed: true, reason: 'follow_up' });
    now += 31000;
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'another location' })).toMatchObject({ allowed: false, reason: 'not_addressed' });
  });

  it('always passes protected emergency traffic', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: '10-33 emergency traffic' })).toMatchObject({ allowed: true, reason: 'emergency' });
  });
});
