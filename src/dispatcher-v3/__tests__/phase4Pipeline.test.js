import { describe, expect, it, vi } from 'vitest';
import { V3SpeechPipeline } from '../speechPipeline.js';
import { V3IntentPlanner } from '../intentPlanner.js';
import { materializeV3Plan } from '../planMaterializer.js';
import { composeV3Response } from '../responseComposer.js';
import { CommandLinkGateway } from '../cadGateway.js';
import { normalizeV3RadioHail } from '../liveRuntime.js';

const runtimeContext = Object.freeze({
  runtimeId: 'runtime-4',
  profileId: 'profile-4',
  dispatchCenterId: 'center-4',
  channelId: 12,
  channelName: 'OPS 1',
  roomKey: 'Zone1__OPS1',
  identity: 'AI-DISPATCHER:V3',
  cadUrl: 'https://cad.example.test',
  cadApiKey: 'secret',
  scopes: ['unit.read', 'unit.write', 'call.read', 'call.write'],
});

describe('Dispatcher V3 phase 4 pipeline', () => {
  it('buffers a PTT transmission and sends PCM to STT', async () => {
    const transcribe = vi.fn(async (pcm) => `heard ${pcm.length}`);
    const codec = {
      decodeOpusToPcm: vi.fn(() => Buffer.from([1, 0, 2, 0])),
      releaseSenderDecoder: vi.fn(),
    };
    const pipeline = new V3SpeechPipeline({ runtimeContext, transcribe, codec });
    pipeline.startTransmission({ unitId: 'INDIANA-1', channelId: 12, correlationId: 'corr-4' });
    pipeline.pushFrame({ unitId: 'INDIANA-1', opusPayload: Buffer.from([9, 9]), codec: 'opus' });
    pipeline.pushFrame({ unitId: 'INDIANA-1', opusPayload: Buffer.from([8, 8]), codec: 'opus' });
    const result = await pipeline.endTransmission({ unitId: 'INDIANA-1' });
    expect(result).toMatchObject({ correlationId: 'corr-4', transcript: 'heard 8', audioBytes: 8 });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(codec.releaseSenderDecoder).toHaveBeenCalledWith('INDIANA-1');
  });

  it('recognizes a plain radio hail without sending it to the action planner', () => {
    expect(normalizeV3RadioHail('Indiana-1')).toBe('Indiana-1');
    expect(normalizeV3RadioHail('Indiana 1')).toBe('Indiana 1');
    expect(normalizeV3RadioHail('Indiana one')).toBe('Indiana one');
    expect(normalizeV3RadioHail('show Indiana 1 en route')).toBeNull();
    expect(normalizeV3RadioHail('10-33')).toBeNull();
  });

  it('bypasses the LLM for protected emergency traffic', async () => {
    const planner = new V3IntentPlanner({ client: null });
    const plan = await planner.plan({ transcript: 'Central, Indiana 1, 10-33 emergency traffic', speakerCallsign: 'INDIANA-1', runtimeContext, correlationId: 'emerg-1' });
    expect(plan.action).toBe('DECLARE_EMERGENCY');
    expect(plan.input.unitRef).toBe('INDIANA-1');
    expect(plan.confidence).toBe(1);
  });

  it('bypasses the LLM and CAD for routine radio checks', async () => {
    const planner = new V3IntentPlanner({ client: null });
    for (const transcript of ['radio check', 'can you give me a radio check?', 'how do you copy me?', 'do you copy me']) {
      const plan = await planner.plan({ transcript, speakerCallsign: 'INDIANA-1', runtimeContext, correlationId: 'radio-check-1' });
      expect(plan).toMatchObject({ action: 'RADIO_CHECK', input: {}, confidence: 1, reason: 'deterministic_radio_check' });
      const unitIdentityService = { resolve: vi.fn(async () => { throw new Error('radio check must not resolve CAD identity'); }) };
      const materialized = await materializeV3Plan(plan, { speakerCallsign: 'INDIANA-1', unitIdentityService, correlationId: 'radio-check-1' });
      expect(materialized.input).toEqual({});
      expect(unitIdentityService.resolve).not.toHaveBeenCalled();
      expect(composeV3Response({ plan: materialized, result: { success: true, data: { acknowledged: true } }, speakerCallsign: 'INDIANA-1' })).toBe('INDIANA-1, loud and clear.');
    }
  });

  it('materializes spoken unit references into immutable UUIDs before execution', async () => {
    const unitIdentityService = {
      resolve: vi.fn(async (ref) => ({ unitId: ref === 'INDIANA-2' ? 'uuid-2' : 'uuid-1', callsign: ref })),
    };
    const plan = await materializeV3Plan({ action: 'SET_UNIT_STATUS', input: { unitRef: 'INDIANA-2', status: 'en_route' } }, { speakerCallsign: 'INDIANA-1', unitIdentityService, correlationId: 'corr-5' });
    expect(plan.input).toEqual({ unitId: 'uuid-2', status: 'en_route' });
  });

  it('does not falsely promise that backup is en route', () => {
    const text = composeV3Response({
      plan: { action: 'REQUEST_BACKUP', input: {} },
      result: { success: true, data: { requested: true } },
      speakerCallsign: 'INDIANA-1',
      now: new Date('2026-08-07T15:59:00Z'),
    });
    expect(text).toBe('INDIANA-1, backup request sent, eleven fifty-nine hours.');
    expect(text.toLowerCase()).not.toContain('en route');
  });

  it('does not read the generated call number over the air after creating a call', () => {
    const text = composeV3Response({
      plan: { action: 'CREATE_CALL', input: { type: 'building check', location: '100 Main St' } },
      result: { success: true, data: { call_number: '26-000123' } },
      speakerCallsign: 'INDIANA-1',
      now: new Date('2026-08-07T15:59:00Z'),
    });
    expect(text).toBe('INDIANA-1, call created, eleven fifty-nine hours.');
    expect(text).not.toContain('26-000123');
  });

  it('unwraps Command Link payloads through gateway helpers', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ success: true, unit: { id: 'uuid-1' } }),
    }));
    const gateway = new CommandLinkGateway(runtimeContext, { fetchImpl, maxSafeRetries: 0 });
    const body = await gateway.get('/api/radio/unit/resolve-v3', { query: { unit_ref: 'INDIANA-1' }, correlationId: 'corr-6' });
    expect(body.unit.id).toBe('uuid-1');
  });
});
