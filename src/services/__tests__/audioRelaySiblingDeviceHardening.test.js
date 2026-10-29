import { describe, expect, it, vi } from 'vitest';
import { installAudioRelaySiblingDeviceHardening } from '../audioRelaySiblingDeviceHardening.js';

function makeService() {
  const sends = [];
  const channelKey = 'OPS__1';
  const sourceEndpoint = { address: '10.0.0.10', port: 40001 };
  const siblingEndpoint = { address: '10.0.0.11', port: 40002 };
  const otherUnitEndpoint = { address: '10.0.0.12', port: 40003 };

  const service = {
    sends,
    subscribers: new Map([
      [channelKey, new Map([
        ['phone-device', {
          unitId: 'INDIANA-1',
          deviceId: 'phone-device',
          ...sourceEndpoint,
          lastSeen: Date.now(),
        }],
        ['t320-device', {
          unitId: 'INDIANA-1',
          deviceId: 't320-device',
          ...siblingEndpoint,
          lastSeen: Date.now(),
        }],
        ['other-radio', {
          unitId: 'INDIANA-2',
          deviceId: 'other-radio',
          ...otherUnitEndpoint,
          lastSeen: Date.now(),
        }],
      ])],
    ]),
    socket: {
      send(payload, offset, length, port, address) {
        sends.push({ payload, offset, length, port, address });
      },
    },
    _parsePacket: vi.fn(() => ({
      channelId: 101,
      senderUnitId: 'INDIANA-1',
      senderDeviceId: 'phone-device',
    })),
    _resolveChannelKeyFromNumeric: vi.fn(() => channelKey),
    _handlePacket(msg, rinfo) {
      this._broadcastToAll(
        channelKey,
        'INDIANA-1',
        Buffer.from([1, 2, 3]),
        7,
        Buffer.from([9, 9]),
        101,
        'INDIANA-1'
      );
    },
    _broadcastToAll(ch, senderUnitId, rxPayload) {
      const subs = this.subscribers.get(ch);
      if (!subs) return;
      for (const [subKey, subInfo] of subs) {
        // Mirrors the production relay's legacy behavior: it handles other
        // units and suppresses every endpoint sharing the sender unit.
        if ((subInfo.unitId || subKey) === senderUnitId) continue;
        this.socket.send(rxPayload, 0, rxPayload.length, subInfo.port, subInfo.address);
      }
    },
  };

  return { service, sourceEndpoint, siblingEndpoint, otherUnitEndpoint };
}

describe('audio relay same-unit sibling routing', () => {
  it('delivers phone audio to a sibling T320 without echoing to the source endpoint', () => {
    const { service, sourceEndpoint, siblingEndpoint, otherUnitEndpoint } = makeService();
    installAudioRelaySiblingDeviceHardening(service);

    service._handlePacket(Buffer.from([2]), sourceEndpoint);

    const endpoints = service.sends.map((send) => `${send.address}:${send.port}`);
    expect(endpoints).toContain(`${siblingEndpoint.address}:${siblingEndpoint.port}`);
    expect(endpoints).toContain(`${otherUnitEndpoint.address}:${otherUnitEndpoint.port}`);
    expect(endpoints).not.toContain(`${sourceEndpoint.address}:${sourceEndpoint.port}`);
    expect(endpoints).toHaveLength(2);
  });

  it('does not alter unit-level suppression for non-UDP injected broadcasts', () => {
    const { service, siblingEndpoint, otherUnitEndpoint } = makeService();
    installAudioRelaySiblingDeviceHardening(service);

    service._broadcastToAll(
      'OPS__1',
      'INDIANA-1',
      Buffer.from([1, 2, 3]),
      8,
      Buffer.from([9, 9]),
      101,
      null
    );

    const endpoints = service.sends.map((send) => `${send.address}:${send.port}`);
    expect(endpoints).not.toContain(`${siblingEndpoint.address}:${siblingEndpoint.port}`);
    expect(endpoints).toEqual([`${otherUnitEndpoint.address}:${otherUnitEndpoint.port}`]);
  });
  it('suppresses stale registrations for the transmitting device after a port change', () => {
    const { service, sourceEndpoint, siblingEndpoint, otherUnitEndpoint } = makeService();
    const staleEndpoint = { address: '10.0.0.10', port: 49999 };
    service.subscribers.get('OPS__1').set('obsolete-source-socket', {
      unitId: 'INDIANA-1',
      deviceId: 'phone-device',
      ...staleEndpoint,
      lastSeen: Date.now() - 30_000,
    });
    installAudioRelaySiblingDeviceHardening(service);
    service._handlePacket(Buffer.from([2]), sourceEndpoint);

    const endpoints = service.sends.map(send => `${send.address}:${send.port}`);
    expect(endpoints).not.toContain(`${sourceEndpoint.address}:${sourceEndpoint.port}`);
    expect(endpoints).not.toContain(`${staleEndpoint.address}:${staleEndpoint.port}`);
    expect(endpoints).toContain(`${siblingEndpoint.address}:${siblingEndpoint.port}`);
    expect(endpoints).toContain(`${otherUnitEndpoint.address}:${otherUnitEndpoint.port}`);
    expect(endpoints).toHaveLength(2);
  });

  it('keeps endpoint protection for legacy radios without a device id', () => {
    const { service, sourceEndpoint, siblingEndpoint, otherUnitEndpoint } = makeService();
    service._parsePacket = vi.fn(() => ({
      channelId: 101,
      senderUnitId: 'INDIANA-1',
      senderDeviceId: null,
    }));
    installAudioRelaySiblingDeviceHardening(service);
    service._handlePacket(Buffer.from([1]), sourceEndpoint);

    const endpoints = service.sends.map(send => `${send.address}:${send.port}`);
    expect(endpoints).not.toContain(`${sourceEndpoint.address}:${sourceEndpoint.port}`);
    expect(endpoints).toContain(`${siblingEndpoint.address}:${siblingEndpoint.port}`);
    expect(endpoints).toContain(`${otherUnitEndpoint.address}:${otherUnitEndpoint.port}`);
  });

  it('does not deliver a transmission to a same-device alias behind a second IP', () => {
    const { service, sourceEndpoint, otherUnitEndpoint } = makeService();
    service.subscribers.get('OPS__1').set('moved-alias', {
      unitId: 'INDIANA-1',
      deviceId: 'phone-device',
      address: '192.0.2.80',
      port: 45001,
      lastSeen: Date.now(),
    });
    installAudioRelaySiblingDeviceHardening(service);
    service._handlePacket(Buffer.from([2]), sourceEndpoint);
    const endpoints = service.sends.map(send => `${send.address}:${send.port}`);
    expect(endpoints).not.toContain('192.0.2.80:45001');
    expect(endpoints).toContain(`${otherUnitEndpoint.address}:${otherUnitEndpoint.port}`);
  });

});
