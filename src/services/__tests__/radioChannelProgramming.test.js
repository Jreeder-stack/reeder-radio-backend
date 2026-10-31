import { describe, expect, it, vi } from 'vitest';
import {
  filterRadioChannels, validateRadioChannelIds, readRadioProgramming,
  replaceRadioProgramming
} from '../radioChannelProgramming.js';

const allowed = [
  { id: 2, name: 'OPS', zone: 'MAIN', room_key: 'MAIN__OPS' },
  { id: 9, name: 'TAC', zone: 'MAIN', room_key: 'MAIN__TAC' }
];

describe('radio-specific programming', () => {
  it('inherits permitted channels when custom programming is off', () => {
    expect(filterRadioChannels(allowed, { custom: false, channelIds: [] })).toEqual(allowed);
  });
  it('preserves order but cannot include out-of-scope channels', () => {
    expect(filterRadioChannels(allowed, { custom: true, channelIds: [9, 999, 2] })).toEqual([allowed[1], allowed[0]]);
    expect(filterRadioChannels(allowed, { custom: true, channelIds: [] })).toEqual([]);
  });
  it('rejects unauthorised, duplicate, malformed and oversized IDs', () => {
    expect(validateRadioChannelIds([9, 2], allowed)).toEqual([9, 2]);
    expect(validateRadioChannelIds(null, allowed)).toBeNull();
    for (const item of [[9,9],[999],[-1],['9'],[1.2],undefined,{},Array(257).fill(2)])
      expect(() => validateRadioChannelIds(item, allowed)).toThrow();
  });
  it('does not turn an explicit empty program into inherited access', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await readRadioProgramming('000001', true, db)).toEqual({ custom: true, channelIds: [] });
    expect(await readRadioProgramming('000001', false, db)).toEqual({ custom: false, channelIds: [] });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it('writes a custom list under a row lock in one transaction', async () => {
    const seen = [];
    const client = {
      query: vi.fn(async (sql, args) => {
        seen.push([sql, args]);
        if (sql.includes('FOR UPDATE')) return { rows: [{ assigned_unit_id: 7 }] };
        return { rows: [] };
      }), release: vi.fn(),
    };
    await replaceRadioProgramming('000001', 7, [9,2], { connect: async () => client });
    expect(seen.map(x=>x[0])).toEqual([
      'BEGIN', 'SELECT assigned_unit_id FROM radios WHERE radio_id = $1 FOR UPDATE',
      'DELETE FROM radio_channel_programming WHERE radio_id = $1',
      'INSERT INTO radio_channel_programming (radio_id, channel_id, sort_order) VALUES ($1, $2, $3)',
      'INSERT INTO radio_channel_programming (radio_id, channel_id, sort_order) VALUES ($1, $2, $3)',
      'UPDATE radios SET custom_channel_programming = $2 WHERE radio_id = $1', 'COMMIT'
    ]);
    expect(seen[3][1]).toEqual(['000001',9,0]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  it('refuses to program another unit after reassignment and rolls back', async () => {
    const queries = [];
    const client = {
      query: vi.fn(async sql => {
        queries.push(sql);
        if (sql.includes('FOR UPDATE')) return { rows: [{ assigned_unit_id: 8 }] };
        return { rows: [] };
      }), release: vi.fn(),
    };
    await expect(replaceRadioProgramming('000001',7,[9],{connect:async()=>client}))
      .rejects.toMatchObject({code:'RADIO_ASSIGNMENT_CHANGED'});
    expect(queries).toEqual([
      'BEGIN','SELECT assigned_unit_id FROM radios WHERE radio_id = $1 FOR UPDATE','ROLLBACK'
    ]);
  });
});
