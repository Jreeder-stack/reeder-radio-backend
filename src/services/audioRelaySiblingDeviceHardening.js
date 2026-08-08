import { canonicalChannelKey } from './channelKeyUtils.js';

const SIBLING_LOG_INTERVAL_MS = 5000;

/**
 * Preserve the relay's legacy unit-level echo suppression for all normal
 * recipients, but explicitly deliver inbound UDP audio to other physical
 * devices that share the same unit identity.
 *
 * The original relay suppresses every UDP subscriber whose unitId matches the
 * sender. That prevents a phone and T320 logged in as the same unit from ever
 * hearing one another. We capture the exact inbound UDP endpoint while the
 * packet is being handled, manually deliver to same-unit sibling endpoints,
 * then let the original broadcast path handle every other recipient plus WS,
 * listeners, recordings, and diagnostics unchanged.
 */
export function installAudioRelaySiblingDeviceHardening(audioRelayService) {
  if (!audioRelayService || audioRelayService._siblingDeviceRoutingInstalled) return;

  audioRelayService._siblingDeviceRoutingInstalled = true;
  audioRelayService._activeInboundUdpSource = null;
  audioRelayService._siblingDeliveryLastLog = new Map();

  const originalHandlePacket = audioRelayService._handlePacket.bind(audioRelayService);
  audioRelayService._handlePacket = function siblingAwareHandlePacket(msg, rinfo) {
    let source = null;
    try {
      const parsed = this._parsePacket?.(msg, 0) || null;
      if (parsed?.senderUnitId) {
        const channelKey = this._resolveChannelKeyFromNumeric?.(parsed.channelId) || null;
        if (channelKey) {
          source = {
            channelKey: canonicalChannelKey(channelKey),
            unitId: parsed.senderUnitId,
            deviceId: parsed.senderDeviceId || null,
            address: rinfo?.address || null,
            port: Number(rinfo?.port) || null,
          };
          this._activeInboundUdpSource = source;
        }
      }
      return originalHandlePacket(msg, rinfo);
    } finally {
      if (this._activeInboundUdpSource === source) {
        this._activeInboundUdpSource = null;
      }
    }
  };

  const originalBroadcastToAll = audioRelayService._broadcastToAll.bind(audioRelayService);
  audioRelayService._broadcastToAll = function siblingAwareBroadcast(
    channelKey,
    senderUnitId,
    rxPayload,
    sequence,
    opusPayload,
    channelIdNumeric = null,
    resolvedSender = null,
    rawPcmSamples = null
  ) {
    const key = canonicalChannelKey(channelKey);
    const source = this._activeInboundUdpSource;
    const sourceMatches = source &&
      source.channelKey === key &&
      source.unitId === senderUnitId &&
      source.address &&
      source.port;

    if (sourceMatches && this.socket && rxPayload?.length > 0) {
      const udpSubs = this.subscribers.get(key);
      if (udpSubs) {
        const sentEndpoints = new Set();
        let siblingCount = 0;

        for (const [subKey, subInfo] of udpSubs) {
          const recipientUnitId = subInfo.unitId || subKey;
          if (recipientUnitId !== senderUnitId) continue;

          const isSourceEndpoint = subInfo.address === source.address &&
            Number(subInfo.port) === Number(source.port);
          if (isSourceEndpoint) continue;

          const endpointKey = `${subInfo.address}:${subInfo.port}`;
          if (sentEndpoints.has(endpointKey)) continue;
          sentEndpoints.add(endpointKey);

          try {
            this.socket.send(rxPayload, 0, rxPayload.length, subInfo.port, subInfo.address);
            siblingCount++;
          } catch (err) {
            console.error(
              `[AudioRelay] SAME_UNIT_SIBLING_SEND_ERROR channelKey=${key} ` +
              `sender=${senderUnitId} recipient=${subKey} error=${err.message}`
            );
          }
        }

        if (siblingCount > 0) {
          const logKey = `${key}::${senderUnitId}`;
          const now = Date.now();
          const lastLog = this._siblingDeliveryLastLog.get(logKey) || 0;
          if (now - lastLog >= SIBLING_LOG_INTERVAL_MS) {
            this._siblingDeliveryLastLog.set(logKey, now);
            console.log(
              `[AudioRelay] SAME_UNIT_SIBLING_UDP_DELIVERY channelKey=${key} ` +
              `sender=${senderUnitId} senderDeviceId=${source.deviceId || 'legacy'} ` +
              `recipients=${siblingCount}`
            );
          }
        }
      }
    }

    return originalBroadcastToAll(
      channelKey,
      senderUnitId,
      rxPayload,
      sequence,
      opusPayload,
      channelIdNumeric,
      resolvedSender,
      rawPcmSamples
    );
  };

  console.log('[AudioRelay] Same-unit sibling device routing installed');
}
