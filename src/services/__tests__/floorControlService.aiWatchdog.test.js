import { describe, it, expect, beforeEach, vi } from 'vitest';

let floorControlService;
let AI_FLOOR_HOLD_TIMEOUT_MS;
let FLOOR_HOLD_TIMEOUT_MS;
let AI_FLOOR_IDENTITY;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const mod = await import('../floorControlService.js');
  floorControlService = mod.floorControlService;
  AI_FLOOR_HOLD_TIMEOUT_MS = mod.AI_FLOOR_HOLD_TIMEOUT_MS;
  FLOOR_HOLD_TIMEOUT_MS = mod.FLOOR_HOLD_TIMEOUT_MS;
  AI_FLOOR_IDENTITY = mod.AI_FLOOR_IDENTITY;
});

describe('FloorControlService AI watchdog (Task #515)', () => {
  it('AI grant times out after 3 s when no release fires', () => {
    const res = floorControlService.requestFloor('CH-1', AI_FLOOR_IDENTITY);
    expect(res.granted).toBe(true);
    expect(floorControlService.holdsFloor('CH-1', AI_FLOOR_IDENTITY)).toBe(true);

    vi.advanceTimersByTime(AI_FLOOR_HOLD_TIMEOUT_MS - 1);
    expect(floorControlService.holdsFloor('CH-1', AI_FLOOR_IDENTITY)).toBe(true);

    vi.advanceTimersByTime(2);
    expect(floorControlService.holdsFloor('CH-1', AI_FLOOR_IDENTITY)).toBe(false);
  });

  it('field-unit grant still times out at 30 s, not 3 s', () => {
    const res = floorControlService.requestFloor('CH-2', 'FIELD-1');
    expect(res.granted).toBe(true);

    vi.advanceTimersByTime(AI_FLOOR_HOLD_TIMEOUT_MS + 100);
    expect(floorControlService.holdsFloor('CH-2', 'FIELD-1')).toBe(true);

    vi.advanceTimersByTime(FLOOR_HOLD_TIMEOUT_MS - AI_FLOOR_HOLD_TIMEOUT_MS);
    expect(floorControlService.holdsFloor('CH-2', 'FIELD-1')).toBe(false);
  });

  it('re-arm on AI re-request resets to 3 s', () => {
    floorControlService.requestFloor('CH-3', AI_FLOOR_IDENTITY);

    vi.advanceTimersByTime(AI_FLOOR_HOLD_TIMEOUT_MS - 500);
    // Re-request by same holder should re-arm timer
    floorControlService.requestFloor('CH-3', AI_FLOOR_IDENTITY);

    vi.advanceTimersByTime(600);
    // Original would have expired by now — but re-arm pushed it out
    expect(floorControlService.holdsFloor('CH-3', AI_FLOOR_IDENTITY)).toBe(true);

    vi.advanceTimersByTime(AI_FLOOR_HOLD_TIMEOUT_MS);
    expect(floorControlService.holdsFloor('CH-3', AI_FLOOR_IDENTITY)).toBe(false);
  });
});
