import { afterEach, describe, expect, it, vi } from 'vitest';
import { signalingService } from '../signalingService.js';
import { floorControlService, AI_FLOOR_IDENTITY } from '../floorControlService.js';

const originalIo = signalingService.io;
afterEach(() => {
  signalingService.io = originalIo;
  vi.restoreAllMocks();
});

function attachChannel() {
  const rx = { rooms: new Set(['channel:Dispatch__OPS1']), emit: vi.fn() };
  const other = { rooms: new Set(['channel:Other__OPS1']), emit: vi.fn() };
  signalingService.io = { sockets: { sockets: new Map([['rx', rx], ['other', other]]) } };
  return { rx, other };
}

describe('AI Dispatcher radio RX activity notification', () => {
  it('emits normal RX start/stop only to members of its authorized channel', () => {
    const { rx, other } = attachChannel();
    const holder = vi.spyOn(floorControlService, 'getFloorHolder')
      .mockReturnValueOnce({ floorKey: AI_FLOOR_IDENTITY })
      .mockReturnValueOnce(null);
    expect(signalingService.publishAiRadioAudio('Dispatch__OPS1', 'AI-DISPATCHER:TEST', true)).toBe(true);
    expect(signalingService.publishAiRadioAudio('Dispatch__OPS1', 'AI-DISPATCHER:TEST', false)).toBe(true);
    expect(holder).toHaveBeenCalledTimes(2);
    expect(rx.emit).toHaveBeenNthCalledWith(1, 'tx:start',
      expect.objectContaining({ channelId: 'Dispatch__OPS1', senderUnitId: 'AI-DISPATCHER:TEST' }));
    expect(rx.emit).toHaveBeenNthCalledWith(2, 'tx:stop',
      expect.objectContaining({ senderUnitId: 'AI-DISPATCHER:TEST' }));
    expect(rx.emit).toHaveBeenNthCalledWith(3, 'channel:idle',
      expect.objectContaining({ channelId: 'Dispatch__OPS1' }));
    expect(other.emit).not.toHaveBeenCalled();
  });

  it('rejects a virtual start unless the actual AI floor is held', () => {
    const { rx } = attachChannel();
    vi.spyOn(floorControlService, 'getFloorHolder')
      .mockReturnValue({ floorKey: 'OTHER-UNIT' });
    expect(signalingService.publishAiRadioAudio('Dispatch__OPS1', 'AI-DISPATCHER:TEST', true)).toBe(false);
    expect(rx.emit).not.toHaveBeenCalled();
  });

  it('does not emit channel idle while a new holder is on the channel', () => {
    const { rx } = attachChannel();
    vi.spyOn(floorControlService, 'getFloorHolder')
      .mockReturnValue({ floorKey: 'INDIANA-2' });
    signalingService.publishAiRadioAudio('Dispatch__OPS1', 'AI-DISPATCHER:TEST', false);
    expect(rx.emit).not.toHaveBeenCalled();
  });
});
