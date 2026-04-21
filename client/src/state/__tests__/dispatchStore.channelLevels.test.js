import { describe, it, expect, beforeEach, vi } from 'vitest';

const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((k) => (k in store ? store[k] : null)),
    setItem: vi.fn((k, v) => { store[k] = String(v); }),
    removeItem: vi.fn((k) => { delete store[k]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

vi.stubGlobal('localStorage', localStorageMock);

describe('dispatchStore.setChannels — channelLevels cleanup (Task #427)', () => {
  let useDispatchStore;

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    const mod = await import('../dispatchStore.js');
    useDispatchStore = mod.default;
  });

  it('preserves volume_<id> keys for channels that still exist (numeric IDs)', () => {
    const store = useDispatchStore.getState();
    store.setChannels([
      { id: 1, name: 'Alpha', zone: 'Z1', room_key: 'Z1__Alpha' },
      { id: 2, name: 'Bravo', zone: 'Z1', room_key: 'Z1__Bravo' },
    ]);
    store.setChannelLevel('volume_1', 60);
    store.setChannelLevel('volume_2', 120);
    store.setChannelLevel(1, 0.5);
    store.setChannelLevel(2, 0.75);

    useDispatchStore.getState().setChannels([
      { id: 1, name: 'Alpha', zone: 'Z1', room_key: 'Z1__Alpha' },
      { id: 2, name: 'Bravo', zone: 'Z1', room_key: 'Z1__Bravo' },
    ]);

    const levels = useDispatchStore.getState().channelLevels;
    expect(levels['volume_1']).toBe(60);
    expect(levels['volume_2']).toBe(120);
    expect(levels[1]).toBe(0.5);
    expect(levels[2]).toBe(0.75);
  });

  it('drops volume_<id> keys for channels that no longer exist', () => {
    const store = useDispatchStore.getState();
    store.setChannels([
      { id: 1, name: 'Alpha', room_key: 'A' },
      { id: 2, name: 'Bravo', room_key: 'B' },
      { id: 3, name: 'Charlie', room_key: 'C' },
    ]);
    store.setChannelLevel('volume_1', 60);
    store.setChannelLevel('volume_2', 80);
    store.setChannelLevel('volume_3', 100);

    useDispatchStore.getState().setChannels([
      { id: 1, name: 'Alpha', room_key: 'A' },
    ]);

    const levels = useDispatchStore.getState().channelLevels;
    expect(levels['volume_1']).toBe(60);
    expect(levels['volume_2']).toBeUndefined();
    expect(levels['volume_3']).toBeUndefined();
  });
});
