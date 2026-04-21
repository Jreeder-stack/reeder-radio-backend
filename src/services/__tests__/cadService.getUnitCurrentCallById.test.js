import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function mockFetchJson(payload, { status = 200 } = {}) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
}

let cadService;

beforeEach(async () => {
  vi.resetModules();
  process.env.CAD_URL = 'https://cad.example.com';
  process.env.CAD_API_KEY = 'test-key';
  cadService = await import('../cadService.js');
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('getUnitCurrentCallById response normalization', () => {
  it('flattens the nested call payload from the live CAD API shape', async () => {
    const livePayload = {
      unit_id: 'INDIANA-1',
      has_active_call: true,
      call: {
        call_id: 'abc-123-uuid',
        call_number: '1-26-000169',
        nature: 'BUILDING CHECK',
        location: '111 NEW BRITAIN BOULEVARD',
        status: 'pending',
        assigned_at: '2026-04-21T19:57:00Z',
        arrived_at: null,
        assigned_units: ['INDIANA-1'],
      },
    };
    global.fetch = mockFetchJson(livePayload);

    const result = await cadService.getUnitCurrentCallById('INDIANA-1');

    expect(result.call_id).toBe('abc-123-uuid');
    expect(result.call_number).toBe('1-26-000169');
    expect(result.nature).toBe('BUILDING CHECK');
    expect(result.location).toBe('111 NEW BRITAIN BOULEVARD');
    expect(result.status).toBe('pending');
    expect(result.assigned_units).toEqual(['INDIANA-1']);
    expect(result.has_active_call).toBe(true);
    expect(result.unit_id).toBe('INDIANA-1');
    // Original nested form preserved for any future caller.
    expect(result.call).toEqual(livePayload.call);
  });

  it('returns callNumber: null when no active call is assigned', async () => {
    global.fetch = mockFetchJson({
      unit_id: 'INDIANA-1',
      has_active_call: false,
      call: null,
    });

    const result = await cadService.getUnitCurrentCallById('INDIANA-1');

    expect(result.callNumber).toBeNull();
    expect(result.has_active_call).toBe(false);
  });

  it('returns callNumber: null on application-level failure', async () => {
    global.fetch = mockFetchJson({ success: false, error: 'boom' });

    const result = await cadService.getUnitCurrentCallById('INDIANA-1');

    expect(result.callNumber).toBeNull();
  });

  it('returns callNumber: null when no unit ID is provided', async () => {
    const result = await cadService.getUnitCurrentCallById('');
    expect(result.callNumber).toBeNull();
  });
});
