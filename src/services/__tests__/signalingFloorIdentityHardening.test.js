import { afterEach, describe, expect, it, vi } from 'vitest';
import { floorControlService } from '../floorControlService.js';
import { installFloorIdentityHardening } from '../signalingFloorIdentityHardening.js';

function makeIoRecorder() {
  const events = [];
  return {
    events,
    to(room) {
      return {
        emit(event, payload) {
          events.push({ room, event, payload });
        },
      };
    },
  };
}

function makeService(overrides = {}) {
  return {
    activeTransmissions: new Map(),
    drainingTransmissions: new Map(),
    unitPresence: new Map(),
    io: makeIoRecorder(),
    _transmissionSweepTimer: null,
    _findSocketByFloorKey: () => null,
    _handleRadioJoinChannel: async () => undefined,
    _handlePttRequest: () => undefined,
    _handlePttStart: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const channelId of Object.keys(floorControlService.getActiveFloors())) {
    floorControlService.forceRelease(channelId);
  }
});

describe('signaling floor identity hardening', () => {
  it('keeps an active transmission when its device floor key owns the floor', () => {
    vi.useFakeTimers();
    const service = makeService();
    const channelId = 'OPS__1';
    const floorKey = 'device-uuid-1';

    floorControlService.requestFloor(channelId, floorKey);
    service.activeTransmissions.set(channelId, {
      unitId: 'INDIANA-1',
      deviceId: floorKey,
      floorKey,
      timestamp: Date.now(),
    });

    installFloorIdentityHardening(service);
    service._startActiveTransmissionsSweep();
    vi.advanceTimersByTime(30000);

    expect(service.activeTransmissions.has(channelId)).toBe(true);
    expect(floorControlService.getFloorHolder(channelId)?.floorKey).toBe(floorKey);
    clearInterval(service._transmissionSweepTimer);
  });

  it('normalizes a joined floor holder from device key to human unit id', async () => {
    const emitted = [];
    const channelId = 'OPS__2';
    const floorKey = 'device-uuid-2';
    const service = makeService({
      _findSocketByFloorKey: (key) => key === floorKey
        ? { unitId: 'INDIANA-2', deviceId: floorKey }
        : null,
      _handleRadioJoinChannel: async (socket) => {
        socket.emit('channel:floor_taken', { channelId, heldBy: floorKey, timestamp: Date.now() });
      },
    });
    const socket = {
      emit(event, payload) {
        emitted.push({ event, payload });
      },
    };

    floorControlService.requestFloor(channelId, floorKey);
    installFloorIdentityHardening(service);
    await service._handleRadioJoinChannel(socket, { channelId });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.heldBy).toBe('INDIANA-2');
    expect(emitted[0].payload.heldByUnitId).toBe('INDIANA-2');
    expect(emitted[0].payload.heldByDeviceId).toBe(floorKey);
    expect(emitted[0].payload.heldByFloorKey).toBe(floorKey);
  });

  it('clears a same-device stale transmission before evaluating a new PTT request', () => {
    const channelId = 'OPS__3';
    const floorKey = 'device-uuid-3';
    let activeRecordSeenByOriginal = true;
    const service = makeService({
      _handlePttRequest: () => {
        activeRecordSeenByOriginal = service.activeTransmissions.has(channelId);
      },
    });
    service.activeTransmissions.set(channelId, {
      unitId: 'INDIANA-3',
      deviceId: floorKey,
      floorKey,
      timestamp: Date.now(),
    });
    const socket = {
      unitId: 'INDIANA-3',
      deviceId: floorKey,
      floorKey,
      _channelKeyMap: new Map([[channelId, channelId]]),
      emit: () => undefined,
    };

    installFloorIdentityHardening(service);
    service._handlePttRequest(socket, { channelId });

    expect(activeRecordSeenByOriginal).toBe(false);
  });

  it('does not clear another device transmission for the same unit', () => {
    const channelId = 'OPS__4';
    const service = makeService();
    service.activeTransmissions.set(channelId, {
      unitId: 'INDIANA-4',
      deviceId: 'device-a',
      floorKey: 'device-a',
      timestamp: Date.now(),
    });
    const socket = {
      unitId: 'INDIANA-4',
      deviceId: 'device-b',
      floorKey: 'device-b',
      _channelKeyMap: new Map([[channelId, channelId]]),
      emit: () => undefined,
    };

    let stillPresent = false;
    service._handlePttRequest = () => {
      stillPresent = service.activeTransmissions.has(channelId);
    };

    installFloorIdentityHardening(service);
    service._handlePttRequest(socket, { channelId });

    expect(stillPresent).toBe(true);
  });
});
