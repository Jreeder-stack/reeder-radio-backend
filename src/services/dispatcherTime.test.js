import { describe, expect, it } from 'vitest';
import { formatDispatcherTime } from './dispatcherTime.js';

describe('dispatcher time formatting', () => {
  it('uses the dispatcher timezone and a deterministic 24-hour radio format', () => {
    const date = new Date('2026-07-31T00:04:00.000Z');
    expect(formatDispatcherTime(date)).toBe('twenty oh four hours');
  });

  it('formats an exact hour as hundred hours', () => {
    const date = new Date('2026-07-31T04:00:00.000Z');
    expect(formatDispatcherTime(date)).toBe('zero hundred hours');
  });
});
