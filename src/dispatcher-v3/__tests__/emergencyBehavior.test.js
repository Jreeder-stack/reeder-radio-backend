import { describe, expect, it } from 'vitest';
import { buildMdcTonePcm } from '../liveRuntime.js';
import { planDeterministicV3Intent } from '../deterministicIntent.js';
import { createDefaultV3ActionHandlers } from '../defaultActionHandlers.js';
import { V3_ACTIONS } from '../actionContracts.js';

describe('Dispatcher V3 physical-button-only emergency policy', () => {
  it.each([
    ['shots fired', 'shots_fired'],
    ['I have one at gun point', 'gunpoint'],
    ['I have him at taser point', 'taserpoint'],
    ["I'm fighting with him", 'fight'],
    ['10-33 emergency traffic', 'officer_assist'],
    ['officer down', 'officer_assist'],
  ])('routes urgent voice language into CAD field handling, never emergency activation: %s', (transcript, eventType) => {
    expect(planDeterministicV3Intent({ transcript, speakerCallsign: 'INDIANA-1' })).toMatchObject({
      action: V3_ACTIONS.REPORT_FIELD_INCIDENT,
      input: { unitRef: 'INDIANA-1', eventType, note: transcript },
    });
  });

  it('rejects DECLARE_EMERGENCY even if a planner or caller attempts it', async () => {
    const handlers = createDefaultV3ActionHandlers({
      gateway: {},
      unitIdentityService: { resolve: async () => ({ unitId: 'unit-1', callsign: 'INDIANA-1' }) },
    });
    await expect(handlers[V3_ACTIONS.DECLARE_EMERGENCY]({
      input: { unitId: 'unit-1', reason: 'shots fired' },
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('Dispatcher V3 MDC alert tone', () => {
  it('builds two seconds of 16 kHz signed PCM matching the existing Tone B duration', () => {
    const pcm = buildMdcTonePcm(2000);
    expect(Buffer.isBuffer(pcm)).toBe(true);
    expect(pcm.length).toBe(16000 * 2 * 2);

    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    expect(samples.length).toBe(32000);
    expect(new Set(Array.from(samples.slice(0, 1000)))).toEqual(new Set([12000, -12000]));
  });
});
