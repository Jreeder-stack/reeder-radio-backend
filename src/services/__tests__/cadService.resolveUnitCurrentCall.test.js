// Task #512: resolveUnitCurrentCall — per-unit endpoint with active-list fallback.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function fetchOnceJson(payload, { status = 200 } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
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

describe('Task #512: resolveUnitCurrentCall', () => {
  it('returns the per-unit call and never queries the active-calls list when has_active_call is true', async () => {
    const perUnit = {
      unit_id: 'INDIANA-1',
      has_active_call: true,
      call: {
        call_id: 'abc-123',
        call_number: '1-26-000169',
        status: 'enroute',
        assigned_units: ['INDIANA-1'],
      },
    };
    global.fetch = vi.fn(async () => fetchOnceJson(perUnit));

    const result = await cadService.resolveUnitCurrentCall('INDIANA-1');

    expect(result.source).toBe('per_unit');
    expect(result.call_id).toBe('abc-123');
    expect(result.call_number).toBe('1-26-000169');
    expect(result.has_active_call).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(
      'https://cad.example.com/api/radio/unit/INDIANA-1/call'
    );
  });

  it('falls back to the active-calls list and matches by callsign when per-unit reports no active call', async () => {
    const perUnit = { unit_id: 'INDIANA-1', has_active_call: false, call: null };
    const list = {
      success: true,
      calls: [
        {
          call_id: 'e9bc488f-16ed-4236-b839-b4e306897c7e',
          call_number: '1-26-000171',
          type: 'BUILDING CHECK',
          status: 'assigned',
          assigned_units: ['INDIANA-1'],
        },
      ],
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(fetchOnceJson(perUnit))
      .mockResolvedValueOnce(fetchOnceJson(list));

    const result = await cadService.resolveUnitCurrentCall('INDIANA-1');

    expect(result.source).toBe('active_list_fallback');
    expect(result.call_id).toBe('e9bc488f-16ed-4236-b839-b4e306897c7e');
    expect(result.call_number).toBe('1-26-000171');
    expect(result.status).toBe('assigned');
    expect(result.has_active_call).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toBe(
      'https://cad.example.com/api/radio/calls'
    );
  });

  it('falls back and matches the call when only the unitUuid appears in assigned_units', async () => {
    const perUnit = { unit_id: 'INDIANA-1', has_active_call: false, call: null };
    const uuid = 'fabd3776-54c3-4cf5-88df-38ecde2050bc';
    const list = {
      calls: [
        {
          call_id: 'CALL-XYZ',
          call_number: 'CN-XYZ',
          status: 'pending',
          assigned_units: [uuid],
        },
      ],
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(fetchOnceJson(perUnit))
      .mockResolvedValueOnce(fetchOnceJson(list));

    const result = await cadService.resolveUnitCurrentCall('INDIANA-1', { unitUuid: uuid });

    expect(result.source).toBe('active_list_fallback');
    expect(result.call_id).toBe('CALL-XYZ');
  });

  it('harvests UUIDs from rich assigned_units objects so a follow-up UUID-only lookup succeeds', async () => {
    const harvestedUuid = 'aa11bb22-cc33-4455-8899-aabbccddeeff';
    // First lookup: per-unit empty, list returns a call whose assigned_units
    // includes a rich object exposing both callsign and UUID for INDIANA-1.
    const perUnitEmpty = { unit_id: 'INDIANA-1', has_active_call: false, call: null };
    const listRich = { calls: [{
      call_id: 'CALL-RICH', call_number: 'CN-RICH', status: 'enroute',
      assigned_units: [{ unit_id: 'INDIANA-1', uuid: harvestedUuid }],
    }] };
    // Second lookup (different call, UUID-only assigned_units, no caller UUID,
    // no prior status-check cache). Resolution must succeed via harvested UUID.
    const perUnitEmpty2 = { unit_id: 'INDIANA-1', has_active_call: false, call: null };
    const listUuidOnly = { calls: [{
      call_id: 'CALL-UUID-ONLY', call_number: 'CN-UUID-ONLY', status: 'assigned',
      assigned_units: [harvestedUuid],
    }] };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(fetchOnceJson(perUnitEmpty))
      .mockResolvedValueOnce(fetchOnceJson(listRich))
      .mockResolvedValueOnce(fetchOnceJson(perUnitEmpty2))
      .mockResolvedValueOnce(fetchOnceJson(listUuidOnly));

    const first = await cadService.resolveUnitCurrentCall('INDIANA-1');
    expect(first.call_id).toBe('CALL-RICH');
    expect(cadService.getCachedUnitUuid('INDIANA-1')).toBe(harvestedUuid);

    const second = await cadService.resolveUnitCurrentCall('INDIANA-1');
    expect(second.source).toBe('active_list_fallback');
    expect(second.call_id).toBe('CALL-UUID-ONLY');
  });

  it('returns {callNumber:null, source:"none"} when neither source has a match', async () => {
    const perUnit = { unit_id: 'INDIANA-1', has_active_call: false, call: null };
    const list = { calls: [
      { call_id: 'OTHER', assigned_units: ['LINCOLN-3'], status: 'assigned' },
    ] };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(fetchOnceJson(perUnit))
      .mockResolvedValueOnce(fetchOnceJson(list));

    const result = await cadService.resolveUnitCurrentCall('INDIANA-1');

    expect(result.source).toBe('none');
    expect(result.callNumber).toBeNull();
    expect(result.has_active_call).toBe(false);
  });

  it('emits a UNIT_CURRENT_CALL_LOOKUP log line on every call', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = vi.fn(async () => fetchOnceJson({
      unit_id: 'INDIANA-1', has_active_call: false, call: null,
    }))
      .mockResolvedValueOnce(fetchOnceJson({
        unit_id: 'INDIANA-1', has_active_call: false, call: null,
      }))
      .mockResolvedValueOnce(fetchOnceJson({ calls: [] }));

    await cadService.resolveUnitCurrentCall('INDIANA-1');

    const lookupLogs = logSpy.mock.calls
      .map(args => args[0])
      .filter(s => typeof s === 'string' && s.includes('UNIT_CURRENT_CALL_LOOKUP'));
    expect(lookupLogs.length).toBeGreaterThan(0);
    const payload = JSON.parse(lookupLogs[0].split('UNIT_CURRENT_CALL_LOOKUP ')[1]);
    expect(payload.unitId).toBe('INDIANA-1');
    expect(payload).toHaveProperty('primarySource');
    expect(payload).toHaveProperty('primaryHasCall');
    expect(payload).toHaveProperty('fallbackUsed');
    expect(payload).toHaveProperty('fallbackHit');
    expect(payload).toHaveProperty('resolvedCallId');
    expect(payload).toHaveProperty('resolvedStatus');
    expect(payload).toHaveProperty('uuidSource');
  });

  it('resolves UUID from the persisted units.cad_unit_uuid column when in-memory cache is empty', async () => {
    // Simulate a fresh process: no caller UUID, no in-memory cache, no rich
    // CAD payloads — only the persisted DB mapping. resolveUnitCurrentCall
    // must still match a UUID-only assigned_units entry.
    vi.resetModules();
    const persistedUuid = 'db00bb22-cc33-4455-8899-aabbccddeeff';
    vi.doMock('../../db/index.js', () => ({
      default: {
        query: vi.fn(async (sql) => {
          if (/SELECT cad_unit_uuid FROM units/i.test(sql)) {
            return { rows: [{ cad_unit_uuid: persistedUuid }] };
          }
          return { rows: [] };
        }),
      },
    }));
    const cadServiceFresh = await import('../cadService.js');

    const perUnit = { unit_id: 'INDIANA-1', has_active_call: false, call: null };
    const list = { calls: [{
      call_id: 'CALL-FROM-DB', call_number: 'CN-FROM-DB', status: 'assigned',
      assigned_units: [persistedUuid],
    }] };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(fetchOnceJson(perUnit))
      .mockResolvedValueOnce(fetchOnceJson(list));

    const result = await cadServiceFresh.resolveUnitCurrentCall('INDIANA-1');
    expect(result.source).toBe('active_list_fallback');
    expect(result.call_id).toBe('CALL-FROM-DB');
    vi.doUnmock('../../db/index.js');
  });

  it('refuses without a unit ID', async () => {
    global.fetch = vi.fn();
    const result = await cadService.resolveUnitCurrentCall('');
    expect(result.source).toBe('none');
    expect(result.callNumber).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
