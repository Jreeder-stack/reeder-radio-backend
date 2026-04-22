import { describe, it, expect } from 'vitest';
import { matchDisposition } from '../cadService.js';

describe('Task #482: cadService.matchDisposition', () => {
  it('exact match wins with score 1.0', () => {
    const list = [
      { value: 'Report Taken', label: 'Report Taken' },
      { value: 'Warning Issued', label: 'Warning Issued' },
    ];
    expect(matchDisposition('Report Taken', list)).toEqual({ canonical: 'Report Taken', score: 1.0 });
  });

  it('case-insensitive exact match still scores 1.0', () => {
    const list = [{ value: 'Report Taken', label: 'Report Taken' }];
    expect(matchDisposition('report taken', list)?.canonical).toBe('Report Taken');
  });

  it('synonym maps "with a report" → "Report Taken"', () => {
    const list = [{ value: 'Report Taken', label: 'Report Taken' }];
    const m = matchDisposition('with a report', list);
    expect(m?.canonical).toBe('Report Taken');
    expect(m?.score).toBeGreaterThan(0.5);
  });

  it('synonym maps "GOA" → "Gone on Arrival"', () => {
    const list = [{ value: 'Gone on Arrival', label: 'Gone on Arrival' }];
    expect(matchDisposition('GOA', list)?.canonical).toBe('Gone on Arrival');
  });

  it('synonym maps "verbal warning" → "Warning Issued"', () => {
    const list = [{ value: 'Warning Issued', label: 'Warning Issued' }];
    expect(matchDisposition('verbal warning', list)?.canonical).toBe('Warning Issued');
  });

  it('returns null for empty / missing inputs', () => {
    expect(matchDisposition('', [{ value: 'X', label: 'X' }])).toBe(null);
    expect(matchDisposition('hello', [])).toBe(null);
    expect(matchDisposition('hello', null)).toBe(null);
    expect(matchDisposition(null, [{ value: 'X', label: 'X' }])).toBe(null);
  });

  it('substring partial match resolves to the right canonical', () => {
    const list = [
      { value: 'Citation Issued', label: 'Citation Issued' },
      { value: 'Report Taken', label: 'Report Taken' },
    ];
    expect(matchDisposition('issued a citation today', list)?.canonical).toBe('Citation Issued');
  });

  it('returns null when nothing reasonable matches', () => {
    const list = [{ value: 'Report Taken', label: 'Report Taken' }];
    expect(matchDisposition('xyz unrelated jibberish', list)).toBe(null);
  });
});
