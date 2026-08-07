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

  it('does not trigger when a wake word is only mentioned later in unit traffic', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Indiana 2 tell central I am clear' })).toMatchObject({
      allowed: false,
      reason: 'not_addressed',
    });
  });

  it('uses the signaling identity for a correctly transcribed hail', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Central, Indiana-1' })).toMatchObject({
      allowed: true,
      reason: 'wake_word',
      transcript: 'INDIANA-1',
      hailSource: 'signaling_identity',
    });
  });

  it('still recognizes a hail when STT drops the unit number', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Central, Indiana' })).toMatchObject({
      allowed: true,
      reason: 'wake_word',
      transcript: 'INDIANA-1',
      hailSource: 'signaling_identity',
      heardTranscript: 'Indiana',
    });
  });

  it('normalizes common spoken-number STT variants against the signaling identity', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    for (const transcript of ['Central, Indiana one', 'Central Indiana won', 'Central, Indiana 1']) {
      expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript })).toMatchObject({
        allowed: true,
        reason: 'wake_word',
        transcript: 'INDIANA-1',
        hailSource: 'signaling_identity',
      });
    }
  });

  it('treats a wake-word-only transmission as a hail from the known transmitting unit', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Central' })).toMatchObject({
      allowed: true,
      reason: 'wake_word',
      transcript: 'INDIANA-1',
      hailSource: 'signaling_identity',
    });
  });

  it('does not mistake an actual command for a hail', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Central, can you show me en route' })).toMatchObject({
      allowed: true,
      reason: 'wake_word',
      transcript: 'can you show me en route',
    });
  });

  it('accepts a timed follow-up without another wake word', () => {
    let now = 1000;
    const gate = new V3ConversationGate({ wakeWords: ['central'], pendingMs: 30000, now: () => now });
    gate.expectFollowUp('INDIANA-1', { clarification: 'What location?' });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Fayette County Fair' })).toMatchObject({ allowed: true, reason: 'follow_up' });
    now += 31000;
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'another location' })).toMatchObject({ allowed: false, reason: 'not_addressed' });
  });

  it('explicit wake word cancels a stale clarification and starts a fresh request', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    gate.expectFollowUp('INDIANA-1', { clarification: 'Which call?' });

    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Central, start a building check at 1950 Dug Hill Road' })).toMatchObject({
      allowed: true,
      reason: 'wake_word',
      transcript: 'start a building check at 1950 Dug Hill Road',
      freshRequest: true,
    });

    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'that call' })).toMatchObject({
      allowed: false,
      reason: 'not_addressed',
    });
  });

  it('cancels a radio-hail follow-up when the unit addresses another callsign', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    gate.expectFollowUp('INDIANA-1', { kind: 'radio_hail', callsign: 'INDIANA-1' });

    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Indiana-2, what is your location?' })).toMatchObject({
      allowed: false,
      reason: 'unit_to_unit',
    });

    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'show me en route' })).toMatchObject({
      allowed: false,
      reason: 'not_addressed',
    });
  });

  it('does not hijack a bare hail to another same-family unit', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    gate.expectFollowUp('INDIANA-1', { kind: 'radio_hail', callsign: 'INDIANA-1' });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: 'Indiana 2' })).toMatchObject({ allowed: false, reason: 'unit_to_unit' });
  });

  it('always passes protected emergency traffic', () => {
    const gate = new V3ConversationGate({ wakeWords: ['central'] });
    expect(gate.shouldProcess({ unitId: 'INDIANA-1', transcript: '10-33 emergency traffic' })).toMatchObject({ allowed: true, reason: 'emergency' });
  });
});
