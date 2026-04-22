// Task #502: cadService.addCallNote — categorization and retry behavior.
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

describe('Task #502: categorizeNoteFailure', () => {
  it('classifies HTTP 5xx as cad_5xx', () => {
    expect(cadService.categorizeNoteFailure({
      success: false, statusCode: 503, failureType: 'API_REJECTION',
    })).toBe('cad_5xx');
  });

  it('classifies HTTP 4xx as cad_4xx', () => {
    expect(cadService.categorizeNoteFailure({
      success: false, statusCode: 422, failureType: 'API_REJECTION',
    })).toBe('cad_4xx');
  });

  it('classifies UNREACHABLE without timeout keyword as network', () => {
    expect(cadService.categorizeNoteFailure({
      success: false, failureType: 'UNREACHABLE', error: 'getaddrinfo ENOTFOUND',
      statusCode: null,
    })).toBe('network');
  });

  it('classifies UNREACHABLE with timeout keyword as timeout', () => {
    expect(cadService.categorizeNoteFailure({
      success: false, failureType: 'UNREACHABLE', error: 'request timed out after 5s',
      statusCode: null,
    })).toBe('timeout');
  });

  it('classifies HTTP 2xx with success:false body as cad_app_error', () => {
    expect(cadService.categorizeNoteFailure({
      success: false, statusCode: 200, error: 'Note rejected by workflow',
    })).toBe('cad_app_error');
  });

  it('returns null for a non-failure result', () => {
    expect(cadService.categorizeNoteFailure({ success: true })).toBeNull();
    expect(cadService.categorizeNoteFailure(null)).toBeNull();
  });
});

describe('Task #502: addCallNote retry + structured failure', () => {
  it('returns enriched failure with category + cadMessage on app-level failure (no retry)', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson(
      { success: false, error: 'Note must reference an active call' },
      { status: 200 },
    ));
    const result = await cadService.addCallNote('CALL-X', 'a note', { maxAttempts: 3, baseDelayMs: 0 });
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe('cad_app_error');
    expect(result.cadMessage).toMatch(/Note must reference/);
    expect(result.attempt).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on cad_4xx (permanent)', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson(
      { error: 'bad payload' }, { status: 400 },
    ));
    const result = await cadService.addCallNote('CALL-X', 'note', { maxAttempts: 3, baseDelayMs: 0 });
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe('cad_4xx');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on cad_5xx and succeeds when CAD recovers', async () => {
    let n = 0;
    global.fetch = vi.fn(async () => {
      n++;
      if (n < 3) return fetchOnceJson({ error: 'CAD overloaded' }, { status: 502 });
      return fetchOnceJson({ success: true, note_id: 'N-1' }, { status: 200 });
    });
    const result = await cadService.addCallNote('CALL-X', 'note', { maxAttempts: 3, baseDelayMs: 0 });
    expect(result.success).toBe(true);
    expect(result.note_id).toBe('N-1');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network errors and gives up with enriched failure after maxAttempts', async () => {
    global.fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const result = await cadService.addCallNote('CALL-X', 'note', { maxAttempts: 3, baseDelayMs: 0 });
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe('network');
    expect(result.attempt).toBe(3);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('legacy two-arg signature still works (defaults applied)', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true, note_id: 'N-OK' }));
    const result = await cadService.addCallNote('CALL-X', 'note');
    expect(result.success).toBe(true);
    expect(result.note_id).toBe('N-OK');
  });
});
