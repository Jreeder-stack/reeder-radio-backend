import { describe, expect, it, vi } from 'vitest';
import { V3FieldIncidentCoordinator } from '../fieldIncidentCoordinator.js';

function makeCoordinator({ currentCall = null } = {}) {
  const gateway = {
    get: vi.fn(async () => ({
      source: 'MAI',
      location: {
        address: '132 PECHIN RD', city: 'DUNBAR', municipality: 'DUNBAR BOROUGH', county: 'FAYETTE',
        state: 'PA', zipCode: '15431', latitude: '39.9800', longitude: '-79.6100',
        crossStreet1: 'UNIVERSITY DR', crossStreet2: 'FAIRGROUND RD',
      },
    })),
  };
  const unitIdentityService = {
    resolve: vi.fn(async () => ({ unitId: 'unit-1', callsign: 'INDIANA-1' })),
  };
  const operationalContextService = {
    snapshot: vi.fn(async () => ({ currentCall, activeCalls: currentCall ? [currentCall] : [], units: [] })),
  };
  const createCall = vi.fn(async ({ input }) => ({
    call: { id: 'call-1', type: input.type, location: '132 PECHIN RD', municipality: 'DUNBAR BOROUGH' },
  }));
  const addCallNote = vi.fn(async ({ input }) => ({ call: { id: input.callId, notes: [{ note: input.note }] } }));
  const updateCall = vi.fn(async ({ input }) => ({ call: { id: input.callId, ...input } }));
  const coordinator = new V3FieldIncidentCoordinator({
    gateway, unitIdentityService, operationalContextService, createCall, addCallNote, updateCall,
    getUnitLocation: () => ({ lat: 39.98, lng: -79.61 }),
  });
  return { coordinator, gateway, createCall, addCallNote, updateCall };
}

describe('V3FieldIncidentCoordinator', () => {
  it('acknowledges shots fired, creates CAD activity without emergency activation, and asks for location', async () => {
    const { coordinator, createCall, addCallNote } = makeCoordinator();
    const result = await coordinator.report({
      input: { unitId: 'unit-1', eventType: 'shots_fired', note: 'shots fired', location: null, subjectDescription: null },
      correlationId: 'corr-1',
    });

    expect(result.radioResponse).toBe(`10-4, shots fired, what's your location?`);
    expect(result.pendingGoals).toEqual(['location', 'subject_description']);
    expect(createCall).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ type: 'SHOTS FIRED', location: '39.98,-79.61', unitIds: ['unit-1'] }),
    }));
    expect(addCallNote).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ callId: 'call-1', note: 'shots fired' }),
    }));
  });

  it('creates ASSIST - OFFICER from an unassigned fleeing-subject report and preserves the statement in notes', async () => {
    const { coordinator, createCall, addCallNote } = makeCoordinator();
    await coordinator.report({
      input: { unitId: 'unit-1', eventType: 'officer_assist', note: 'I have one running by the Ferris Wheel', location: null, subjectDescription: null },
      correlationId: 'corr-2',
    });

    expect(createCall).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ type: 'ASSIST - OFFICER', unitIds: ['unit-1'] }),
    }));
    expect(addCallNote).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ note: 'I have one running by the Ferris Wheel' }),
    }));
  });

  it('separates verified address and municipality, records cross streets, then asks for a description', async () => {
    const { coordinator, updateCall, addCallNote } = makeCoordinator({ currentCall: { id: 'call-1', type: 'SHOTS FIRED' } });
    await coordinator.report({
      input: { unitId: 'unit-1', eventType: 'shots_fired', note: 'shots fired', location: null, subjectDescription: null },
      correlationId: 'corr-3a',
    });
    const result = await coordinator.update({
      input: { unitId: 'unit-1', informationType: 'location', value: 'Fayette County Fair in Dunbar', note: null },
      correlationId: 'corr-3b',
    });

    expect(updateCall).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        callId: 'call-1', location: '132 PECHIN RD', city: 'DUNBAR', municipality: 'DUNBAR BOROUGH',
        crossStreet1: 'UNIVERSITY DR', crossStreet2: 'FAIRGROUND RD',
      }),
    }));
    expect(addCallNote).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ note: expect.stringContaining('CROSS STREETS: UNIVERSITY DR / FAIRGROUND RD') }),
    }));
    expect(result.radioResponse).toBe(`10-4. What's the subject's description?`);
  });

  it('captures changed operational direction without repeating the unanswered location question', async () => {
    const { coordinator, addCallNote } = makeCoordinator({ currentCall: { id: 'call-1', type: 'ASSIST - OFFICER' } });
    await coordinator.report({
      input: { unitId: 'unit-1', eventType: 'officer_assist', note: 'I have one running', location: null, subjectDescription: null },
      correlationId: 'corr-4a',
    });
    const result = await coordinator.update({
      input: { unitId: 'unit-1', informationType: 'direction', value: 'north toward the main gate', note: null },
      correlationId: 'corr-4b',
    });

    expect(addCallNote).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ note: 'DIRECTION OF TRAVEL: north toward the main gate' }),
    }));
    expect(result.radioResponse).toBe('10-4.');
    expect(result.pendingGoals).toContain('location');
  });
});
