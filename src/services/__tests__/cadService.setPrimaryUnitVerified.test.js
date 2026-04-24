// Task #528: setPrimaryUnitVerified must read the call back after PATCHing
// and only return success when CAD's call record actually reflects the new
// primary. A second body shape (with primary_unit_id=UUID) is tried when
// the first PATCH is accepted by the API but doesn't move primary.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

let cadService;

const ORIG_FETCH = global.fetch;
const ORIG_CAD_URL = process.env.CAD_URL;
const ORIG_CAD_KEY = process.env.CAD_API_KEY;

function mockJsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(async () => {
  vi.resetModules();
  process.env.CAD_URL = 'https://cad.test';
  process.env.CAD_API_KEY = 'test-key';
  cadService = await import('../cadService.js');
});

afterEach(() => {
  global.fetch = ORIG_FETCH;
  process.env.CAD_URL = ORIG_CAD_URL;
  process.env.CAD_API_KEY = ORIG_CAD_KEY;
});

describe('cadService.setPrimaryUnitVerified (Task #528)', () => {
  it('returns success:true, attempts:1 when first PATCH 200 and re-fetch shows new primary', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, method: opts?.method || 'GET' });
      const isGet = !opts?.method || opts.method === 'GET';
      if (isGet) {
        // before-fetch returns OTHER-1; after-fetch (the 2nd GET) returns INDIANA-2
        const idx = calls.filter(c => c.method === 'GET').length;
        const primary = idx === 1 ? 'OTHER-1' : 'INDIANA-2';
        return mockJsonResponse(200, { call_id: 'C1', primary_unit: primary });
      }
      return mockJsonResponse(200, { ok: true });
    });

    const out = await cadService.setPrimaryUnitVerified('C1', 'INDIANA-2');
    expect(out.success).toBe(true);
    expect(out.attempts).toBe(1);
    expect(out.beforePrimary).toBe('OTHER-1');
    expect(out.afterPrimary).toBe('INDIANA-2');
    expect(out.patchStatus).toBe(200);
    // exactly one PATCH attempted
    expect(calls.filter(c => c.method === 'PATCH').length).toBe(1);
  });

  it('retries with primary_unit_id when first attempt is 200-but-no-effect and unitUuid is known', async () => {
    const patchBodies = [];
    let getCount = 0;
    global.fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'GET') {
        getCount++;
        // 1st GET (before): OTHER-1
        // 2nd GET (after attempt 1): still OTHER-1 (no effect)
        // 3rd GET (after attempt 2): INDIANA-2 (effective)
        const primary = getCount < 3 ? 'OTHER-1' : 'INDIANA-2';
        return mockJsonResponse(200, { call: { primary_unit: primary } });
      }
      if (method === 'PATCH') {
        patchBodies.push(JSON.parse(opts.body));
        return mockJsonResponse(200, { ok: true });
      }
      return mockJsonResponse(204, null);
    });

    const out = await cadService.setPrimaryUnitVerified('C1', 'INDIANA-2', { unitUuid: 'uuid-2' });
    expect(out.success).toBe(true);
    expect(out.attempts).toBe(2);
    expect(out.afterPrimary).toBe('INDIANA-2');
    expect(patchBodies.length).toBe(2);
    expect(patchBodies[0]).toEqual({ primary_unit: 'INDIANA-2', primaryUnit: 'INDIANA-2' });
    expect(patchBodies[1]).toEqual({
      primary_unit: 'INDIANA-2',
      primaryUnit: 'INDIANA-2',
      primary_unit_id: 'uuid-2',
    });
  });

  it('returns success:false when both attempts leave primary unchanged', async () => {
    let patchCount = 0;
    global.fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'GET') {
        return mockJsonResponse(200, { primary_unit: 'OTHER-1' });
      }
      if (method === 'PATCH') {
        patchCount++;
        return mockJsonResponse(200, { ok: true });
      }
      return mockJsonResponse(204, null);
    });

    const out = await cadService.setPrimaryUnitVerified('C1', 'INDIANA-2', { unitUuid: 'uuid-2' });
    expect(out.success).toBe(false);
    expect(out.attempts).toBe(2);
    expect(out.beforePrimary).toBe('OTHER-1');
    expect(out.afterPrimary).toBe('OTHER-1');
    expect(out.patchStatus).toBe(200);
    expect(patchCount).toBe(2);
  });

  it('returns success:false, attempts:1 on a 4xx PATCH and does NOT try a second body', async () => {
    let patchCount = 0;
    global.fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'GET') {
        return mockJsonResponse(200, { primary_unit: 'OTHER-1' });
      }
      if (method === 'PATCH') {
        patchCount++;
        return mockJsonResponse(422, { error: 'invalid payload' });
      }
      return mockJsonResponse(204, null);
    });

    const out = await cadService.setPrimaryUnitVerified('C1', 'INDIANA-2', { unitUuid: 'uuid-2' });
    expect(out.success).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.patchStatus).toBe(422);
    expect(patchCount).toBe(1);
  });

  it('matches success when after-primary equals the unit UUID instead of callsign', async () => {
    let getCount = 0;
    global.fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'GET') {
        getCount++;
        // before: OTHER-1, after: uuid-2 (CAD stored UUID instead of callsign)
        return mockJsonResponse(200, { primary_unit: getCount === 1 ? 'OTHER-1' : 'uuid-2' });
      }
      return mockJsonResponse(200, { ok: true });
    });

    const out = await cadService.setPrimaryUnitVerified('C1', 'INDIANA-2', { unitUuid: 'uuid-2' });
    expect(out.success).toBe(true);
    expect(out.attempts).toBe(1);
    expect(out.afterPrimary).toBe('uuid-2');
  });

  it('rejects empty inputs', async () => {
    const a = await cadService.setPrimaryUnitVerified(null, 'INDIANA-2');
    expect(a.success).toBe(false);
    const b = await cadService.setPrimaryUnitVerified('C1', null);
    expect(b.success).toBe(false);
  });
});
