import { describe, expect, it, vi } from 'vitest';
import { V3DiagnosticsJournal } from '../diagnostics.js';
import { V3ActionExecutor } from '../actionExecutor.js';
const access = (runtimeId, dispatchCenterId) =>
  ({ runtimeId, dispatchCenterId, scopes: ['dispatcher.diagnostics.read'] });

describe('V3DiagnosticsJournal', () => {
  it('redacts sensitive fields and keeps bounded history', () => {
    const logger = { info: vi.fn() };
    const journal = new V3DiagnosticsJournal({ maxEntries: 10, now: () => 0, logger });
    for (let i = 0; i < 12; i += 1) {
      journal.record({
        phase: 'test', runtimeId: 'r1', dispatchCenterId: 'c1',
        correlationId: `c-${i}`,
        details: { apiKey: 'secret', nested: { token: 'hidden', safe: i } },
      });
    }
    const entries = journal.getRecent({ limit: 20, runtimeId: 'r1', access: access('r1','c1') });
    expect(entries).toHaveLength(10);
    expect(entries[0].correlationId).toBe('c-2');
    expect(entries.at(-1).details).toEqual({});
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(JSON.stringify(entries)).not.toContain('hidden');
  });

  it('filters by runtime and correlation ID', () => {
    const journal = new V3DiagnosticsJournal({ logger: null });
    journal.record({ phase: 'a', runtimeId: 'r1', dispatchCenterId:'center-1', correlationId: 'c1' });
    journal.record({ phase: 'b', runtimeId: 'r2', dispatchCenterId:'center-2', correlationId: 'c2' });
    expect(journal.getRecent({ runtimeId: 'r1', access: access('r1','center-1') })).toHaveLength(1);
    expect(journal.getRecent({ correlationId: 'c2', runtimeId:'r2', access: access('r2','center-2') })[0].phase).toBe('b');
    expect(journal.getRecent({runtimeId:'r1'})).toEqual([]);
  });
});

describe('V3ActionExecutor diagnostics', () => {
  const runtime = Object.freeze({
    runtimeId: 'runtime-1',
    dispatchCenterId: 'center-1',
    channelId: 'channel-1',
    scopes: ['unit.read'],
  });

  it('records received, validated, and completed stages with one correlation ID', async () => {
    let time = 1000;
    const journal = new V3DiagnosticsJournal({ logger: null, now: () => time });
    const executor = new V3ActionExecutor({
      runtimeContext: runtime,
      diagnostics: journal,
      now: () => (time += 5),
      handlers: { RADIO_CHECK: async () => ({ acknowledged: true }) },
    });
    const result = await executor.execute({ action: 'RADIO_CHECK', input: {} }, { correlationId: 'trace-1' });
    expect(result.success).toBe(true);
    const trace = journal.getRecent({ correlationId: 'trace-1', runtimeId:'runtime-1',
      access: access('runtime-1','center-1') });
    expect(trace.map((entry) => entry.phase)).toEqual(['action_received', 'action_validated', 'action_completed']);
    expect(trace.at(-1)).toMatchObject({
      runtimeId: 'runtime-1',
      dispatchCenterId: 'center-1',
      channelId: 'channel-1',
      success: true,
    });
  });

  it('records validation failures without invoking a handler', async () => {
    const journal = new V3DiagnosticsJournal({ logger: null });
    const handler = vi.fn();
    const executor = new V3ActionExecutor({
      runtimeContext: runtime,
      diagnostics: journal,
      handlers: { STATUS_CHECK: handler },
    });
    const result = await executor.execute({ action: 'STATUS_CHECK', input: {} }, { correlationId: 'trace-fail' });
    expect(result.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    const trace = journal.getRecent({ correlationId: 'trace-fail', runtimeId:'runtime-1',
      access: access('runtime-1','center-1') });
    expect(trace.map((entry) => entry.phase)).toEqual(['action_received', 'action_failed']);
    expect(trace.at(-1).details.code).toBe('INVALID_ACTION_INPUT');
    expect(trace.at(-1).details).not.toHaveProperty('error');
  });
});
