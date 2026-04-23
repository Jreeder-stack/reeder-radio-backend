// Task #509: cadService.respondToStatusCheck and cancelStatusCheck — body
// shape + URL contract with CAD.
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

function lastFetchCall() {
  const call = global.fetch.mock.calls[global.fetch.mock.calls.length - 1];
  const [url, opts] = call;
  return { url, body: opts?.body ? JSON.parse(opts.body) : null, method: opts?.method || 'GET' };
}

describe('Task #509: respondToStatusCheck body shape', () => {
  it('posts to /api/radio/respond-check with {unit_id, call_id, response:"10-4"} and no status by default', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true }));
    const result = await cadService.respondToStatusCheck('INDIANA-1', 'CALL-UUID-1');
    expect(result.success).not.toBe(false);
    const { url, body, method } = lastFetchCall();
    expect(method).toBe('POST');
    expect(url).toBe('https://cad.example.com/api/radio/respond-check');
    expect(body).toEqual({ unit_id: 'INDIANA-1', call_id: 'CALL-UUID-1', response: '10-4' });
    expect(body).not.toHaveProperty('status');
  });

  it('passing {response: "..."} uses that as the response text', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true }));
    await cadService.respondToStatusCheck('INDIANA-1', 'CALL-UUID-1', { response: '10-4 All Clear' });
    const { body } = lastFetchCall();
    expect(body.response).toBe('10-4 All Clear');
    expect(body).not.toHaveProperty('status');
  });

  it('passing {status: "on_scene"} adds the status field; response defaults to "10-4"', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true }));
    await cadService.respondToStatusCheck('INDIANA-1', 'CALL-UUID-1', { status: 'on_scene' });
    const { body } = lastFetchCall();
    expect(body).toEqual({
      unit_id: 'INDIANA-1', call_id: 'CALL-UUID-1', response: '10-4', status: 'on_scene',
    });
  });

  it('a non-2xx CAD response yields {success:false, statusCode, responseBody}', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ error: 'rejected' }, { status: 422 }));
    const result = await cadService.respondToStatusCheck('INDIANA-1', 'CALL-UUID-1');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(422);
    expect(result.responseBody).toEqual({ error: 'rejected' });
  });

  it('legacy positional string is treated as response text, NEVER as status', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true }));
    await cadService.respondToStatusCheck('INDIANA-1', 'CALL-UUID-1', 'on scene');
    const { body } = lastFetchCall();
    expect(body.response).toBe('on scene');
    expect(body).not.toHaveProperty('status');
  });

  it('refuses without a unit ID', async () => {
    global.fetch = vi.fn();
    const result = await cadService.respondToStatusCheck(null, 'CALL-UUID-1');
    expect(result.success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('Task #509: cancelStatusCheck URL + body', () => {
  it('posts to /api/radio/call/<callId>/status-check/cancel with {unit_id, reason}', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true }));
    const result = await cadService.cancelStatusCheck('INDIANA-1', 'CALL-UUID-1', { reason: 'extended traffic stop' });
    expect(result.success).not.toBe(false);
    const { url, body, method } = lastFetchCall();
    expect(method).toBe('POST');
    expect(url).toBe('https://cad.example.com/api/radio/call/CALL-UUID-1/status-check/cancel');
    expect(body).toEqual({ unit_id: 'INDIANA-1', reason: 'extended traffic stop' });
  });

  it('omits unit_id when called without one (cancels for all units on the call)', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true }));
    await cadService.cancelStatusCheck(null, 'CALL-UUID-1', { reason: 'closed by dispatcher' });
    const { url, body } = lastFetchCall();
    expect(url).toBe('https://cad.example.com/api/radio/call/CALL-UUID-1/status-check/cancel');
    expect(body).toEqual({ reason: 'closed by dispatcher' });
    expect(body).not.toHaveProperty('unit_id');
  });

  it('still rejects when callId is missing', async () => {
    global.fetch = vi.fn();
    const result = await cadService.cancelStatusCheck('INDIANA-1', null, { reason: 'x' });
    expect(result.success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('encodes special characters in callId into the URL path', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true }));
    await cadService.cancelStatusCheck('INDIANA-1', 'call/with spaces');
    const { url } = lastFetchCall();
    expect(url).toBe('https://cad.example.com/api/radio/call/call%2Fwith%20spaces/status-check/cancel');
  });

  it('legacy 2-arg form still works (no reason)', async () => {
    global.fetch = vi.fn(async () => fetchOnceJson({ success: true }));
    await cadService.cancelStatusCheck('INDIANA-1', 'CALL-UUID-1');
    const { body } = lastFetchCall();
    expect(body).toEqual({ unit_id: 'INDIANA-1' });
  });
});
