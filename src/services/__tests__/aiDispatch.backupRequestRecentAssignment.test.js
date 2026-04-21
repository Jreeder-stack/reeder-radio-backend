import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../azureSpeechService.js', () => ({
  speechToText: vi.fn(async () => ({ text: '' })),
  textToSpeech: vi.fn(async () => Buffer.alloc(320)),
  isConfigured: () => true,
}));

vi.mock('../llmIntentService.js', () => ({
  isConfigured: () => false,
  classifyIntent: vi.fn(),
  answerWithData: vi.fn(),
  composeNatural: vi.fn(async (_unitId, draft) => draft),
  rewriteCallNote: vi.fn(async (_unitId, draft) => draft),
}));

vi.mock('../cadService.js', () => {
  return {
    RADIO_STATUS: {},
    extractActualStatusFromRejection: () => null,
    isConfigured: () => true,
    getUnitCurrentCallById: vi.fn(async () => ({ callNumber: null })),
    assignUnitToCall: vi.fn(async () => ({ success: true })),
    updateUnitStatus: vi.fn(async () => ({ success: true })),
    getActiveCalls: vi.fn(async () => ({ calls: [] })),
  };
});

vi.mock('../agencyKnowledge.js', () => ({
  resolveDestination: () => ({ kind: 'unique', place: { name: '', address: null } }),
  KNOWN_PLACES: [],
}));

vi.mock('../db/index.js', () => ({
  default: {},
  isAiDispatchEnabled: async () => true,
  getAiDispatchChannel: async () => null,
  createChannelMessage: async () => null,
}));

let AIDispatcher;
let cadService;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const cm = await import('../commandMatcher.js');
  cm.resetDispatcherState();
  const mod = await import('../aiDispatchService.js');
  AIDispatcher = mod.AIDispatcher;
  cadService = await import('../cadService.js');
});

function makeDispatcher() {
  const d = new AIDispatcher();
  d.connected = true;
  d.isRunning = true;
  d.channelName = 'CH-TEST';
  d.spoken = [];
  d.speak = async (text) => { d.spoken.push(text); };
  d.addConversationExchange = () => {};
  // Stub out roster paging + timeout scheduling so test stays focused.
  d._pageBackupRosterAfterRecording = vi.fn(async () => {});
  d._scheduleBackupRequestTimeout = vi.fn(() => {});
  return d;
}

describe('handleBackupRequestStart — recent-assignment fallback', () => {
  it('(a) CAD returns the call: unchanged behavior, broadcasts and opens request', async () => {
    const d = makeDispatcher();
    cadService.getUnitCurrentCallById.mockResolvedValueOnce({
      call_id: 'CALL-1', call_number: 'CALL-1',
      location: '123 Main St', nature: 'DISTURBANCE',
    });

    await d.handleBackupRequestStart('Indiana-1', 'send me another unit');

    expect(cadService.getUnitCurrentCallById).toHaveBeenCalledTimes(1);
    expect(d.openBackupRequests.size).toBe(1);
    const [req] = [...d.openBackupRequests.values()];
    expect(req.callId).toBe('CALL-1');
    expect(req.location).toBe('123 Main St');
    expect(d.spoken[0]).toMatch(/Any unit in the area of 123 Main St/);
  });

  it('(b) CAD lags then succeeds on retry', async () => {
    const d = makeDispatcher();
    cadService.getUnitCurrentCallById
      .mockResolvedValueOnce({ callNumber: null })
      .mockResolvedValueOnce({
        call_id: 'CALL-2', call_number: 'CALL-2',
        location: '500 Oak Ave', nature: 'TRAFFIC STOP',
      });

    await d.handleBackupRequestStart('Indiana-1', 'send me another unit');

    expect(cadService.getUnitCurrentCallById).toHaveBeenCalledTimes(2);
    expect(d.openBackupRequests.size).toBe(1);
    const [req] = [...d.openBackupRequests.values()];
    expect(req.callId).toBe('CALL-2');
    expect(req.location).toBe('500 Oak Ave');
  });

  it('(c) CAD stays empty but recent-assignment cache has unit: backup proceeds with cached snapshot', async () => {
    const d = makeDispatcher();
    cadService.getUnitCurrentCallById.mockResolvedValue({ callNumber: null });

    d._recordRecentAssignment('Indiana-1', {
      call_id: 'CALL-3', call_number: 'CALL-3',
      location: '7 Pine Rd', nature: 'ASSIST', priority: 'high',
    });

    await d.handleBackupRequestStart('Indiana-1', 'send me another unit');

    expect(cadService.getUnitCurrentCallById).toHaveBeenCalledTimes(2);
    expect(d.openBackupRequests.size).toBe(1);
    const [req] = [...d.openBackupRequests.values()];
    expect(req.callId).toBe('CALL-3');
    expect(req.location).toBe('7 Pine Rd');
    expect(req.nature).toBe('ASSIST');
    expect(req.priority).toBe('high');
    expect(d.spoken[0]).toMatch(/Any unit in the area of 7 Pine Rd/);
  });

  it('(d) no CAD and no cache: existing not-assigned response', async () => {
    const d = makeDispatcher();
    cadService.getUnitCurrentCallById.mockResolvedValue({ callNumber: null });

    await d.handleBackupRequestStart('Indiana-1', 'send me another unit');

    expect(d.openBackupRequests.size).toBe(0);
    expect(d.spoken[0]).toMatch(/you're not assigned to a call/);
  });

  it('(e) cache entry expired past TTL: existing not-assigned response', async () => {
    const d = makeDispatcher();
    cadService.getUnitCurrentCallById.mockResolvedValue({ callNumber: null });

    d._recordRecentAssignment('Indiana-1', {
      call_id: 'CALL-4', call_number: 'CALL-4',
      location: '99 Elm St', nature: 'DISTURBANCE',
    });
    // Force the cached entry to be older than the TTL.
    const key = d._recentAssignmentKey('Indiana-1');
    const entry = d._recentAssignments.get(key);
    entry.assignedAt = Date.now() - (d.RECENT_ASSIGNMENT_TTL_MS + 1000);

    await d.handleBackupRequestStart('Indiana-1', 'send me another unit');

    expect(d.openBackupRequests.size).toBe(0);
    expect(d.spoken[0]).toMatch(/you're not assigned to a call/);
    // Expired entry should be evicted.
    expect(d._recentAssignments.has(key)).toBe(false);
  });
});
