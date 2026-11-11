import { describe, expect, it, vi } from 'vitest';
import { planDeterministicV3Intent } from '../deterministicIntent.js';
import { V3IntentPlanner } from '../intentPlanner.js';

const speakerCallsign = 'INDIANA-1';

async function semanticPlan(transcript, reply, operationalContext = null) {
  expect(planDeterministicV3Intent({ transcript, speakerCallsign, operationalContext })).toBeNull();
  const create = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify({ confidence: 1, ...reply }) } }] }));
  const planner = new V3IntentPlanner({ client: { chat: { completions: { create } } } });
  const result = await planner.plan({ transcript, speakerCallsign, operationalContext });
  expect(create).toHaveBeenCalledTimes(1);
  expect(JSON.parse(create.mock.calls[0][0].messages[1].content)).toMatchObject({ transcript, speakerCallsign });
  return result;
}

describe('Dispatcher V3 deterministic routine commands', () => {
  it.each([
    ['radio check', 'RADIO_CHECK', {}],
    ['what time is it', 'TIME_CHECK', {}],
    ['what call am I on', 'GET_CURRENT_CALL', { unitRef: speakerCallsign }],
    ['what calls are on the screen', 'LIST_ACTIVE_CALLS', {}],
    ["what's my status", 'STATUS_CHECK', { unitRef: speakerCallsign }],
    ['show me en route', 'SET_UNIT_STATUS', { unitRef: speakerCallsign, status: 'en_route' }],
    ['on scene', 'SET_UNIT_STATUS', { unitRef: speakerCallsign, status: 'on_scene' }],
    ['show me arriving', 'SET_UNIT_STATUS', { unitRef: speakerCallsign, status: 'on_scene' }],
    ['available', 'SET_UNIT_STATUS', { unitRef: speakerCallsign, status: 'available' }],
    ['out of service', 'SET_UNIT_STATUS', { unitRef: speakerCallsign, status: 'out_of_service' }],
    ['off duty', 'SET_UNIT_STATUS', { unitRef: speakerCallsign, status: 'off_duty' }],
  ])('plans %s locally as %s', (transcript, action, expectedInput) => {
    const result = planDeterministicV3Intent({ transcript, speakerCallsign });
    expect(result).toMatchObject({ action, confidence: 1, input: expectedInput });
  });

  it.each([
    'INDIANA-1, radio check',
    'Indiana 1 radio check',
    'Indiana one, radio check',
    'Indiana won radio check',
  ])('strips the authenticated speaker callsign before parsing: %s', (transcript) => {
    expect(planDeterministicV3Intent({ transcript, speakerCallsign })).toMatchObject({
      action: 'RADIO_CHECK',
      confidence: 1,
      input: {},
    });
  });

  it('strips the self callsign for other routine commands too', () => {
    expect(planDeterministicV3Intent({ transcript: 'Indiana one, show me en route', speakerCallsign })).toMatchObject({
      action: 'SET_UNIT_STATUS',
      input: { unitRef: speakerCallsign, status: 'en_route' },
      confidence: 1,
    });
  });

  it('does not strip another unit callsign', () => {
    expect(planDeterministicV3Intent({ transcript: 'Indiana 2 radio check', speakerCallsign })).toBeNull();
  });

  it('makes an obvious backup request deterministic and urgent', () => {
    expect(planDeterministicV3Intent({ transcript: 'I need backup', speakerCallsign })).toMatchObject({
      action: 'REQUEST_BACKUP',
      confidence: 1,
      input: { unitRef: speakerCallsign, priority: 'urgent' },
    });
  });

  it('leaves complex multi-field language for Azure OpenAI', () => {
    expect(planDeterministicV3Intent({
      transcript: 'create me a building check at the fairgrounds and put Indiana-2 on it too',
      speakerCallsign,
    })).toBeNull();
  });

  it('preserves semantically planned named-call assignment and status actions', async () => {
    const actions = [
      { action: 'ASSIGN_UNIT', input: { callRef: 'fight', unitRef: speakerCallsign } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: speakerCallsign, status: 'en_route' } },
    ];
    expect(await semanticPlan('show me en route to the fight', { actions })).toMatchObject({
      action: 'MULTI_ACTION',
      actions,
    });
  });

  it('passes named-call context to semantics instead of weak substring selection', async () => {
    const transcript = 'show me en route to the fight';
    const assignment = { actions: [
      { action: 'ASSIGN_UNIT', input: { callId: 'fight-1', unitRef: speakerCallsign } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: speakerCallsign, status: 'en_route' } },
    ] };
    expect(await semanticPlan(transcript, assignment, { currentCall: { id: 'alarm-1', nature: 'BURGLAR ALARM' } }))
      .toMatchObject({ action: 'MULTI_ACTION', actions: assignment.actions });
    const status = { action: 'SET_UNIT_STATUS', input: { unitRef: speakerCallsign, status: 'en_route' } };
    expect(await semanticPlan(transcript, status, { currentCall: { id: 'fight-1', nature: 'FIGHT' } })).toMatchObject(status);
  });

  it.each([
    ['shots fired', 'shots_fired'],
    ['I have one running', 'officer_assist'],
  ])('plans urgent field traffic as a non-emergency field incident: %s', (transcript, eventType) => {
    expect(planDeterministicV3Intent({ transcript, speakerCallsign })).toMatchObject({
      action: 'REPORT_FIELD_INCIDENT',
      input: { unitRef: speakerCallsign, eventType, note: transcript },
    });
  });

  it('preserves a rich first-person field report through semantic interpretation', async () => {
    const transcript = 'I have one running by the Ferris Wheel';
    const report = { action: 'REPORT_FIELD_INCIDENT', input: { unitRef: speakerCallsign, eventType: 'officer_assist', note: transcript } };
    expect(await semanticPlan(transcript, report)).toMatchObject(report);
  });

  it('uses a known disposition for a pending clear but leaves unrelated traffic for semantic planning', () => {
    const pendingContext = { kind: 'disposition', callId: 'call-1' };
    expect(planDeterministicV3Intent({ transcript: 'report taken', speakerCallsign, pendingContext })).toMatchObject({
      action: 'CLEAR_UNIT',
      input: { callId: 'call-1', unitRef: speakerCallsign, disposition: 'REPORT TAKEN' },
    });
    expect(planDeterministicV3Intent({ transcript: `we're by the bumper boats`, speakerCallsign, pendingContext })).toBeNull();
  });

  it('does not call Azure OpenAI for deterministic commands', async () => {
    const create = vi.fn(async () => { throw new Error('Azure should not be called'); });
    const planner = new V3IntentPlanner({ client: { chat: { completions: { create } } } });

    const plan = await planner.plan({
      transcript: 'INDIANA-1, show me available',
      speakerCallsign,
      runtimeContext: { runtimeId: 'runtime-1', dispatchCenterId: 'center-1', channelId: 1, roomKey: 'OPS1' },
      correlationId: 'corr-routine-1',
    });

    expect(plan).toMatchObject({ action: 'SET_UNIT_STATUS', input: { unitRef: speakerCallsign, status: 'available' }, confidence: 1 });
    expect(create).not.toHaveBeenCalled();
  });
});
