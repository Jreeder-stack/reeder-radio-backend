from pathlib import Path
import re


def replace_one(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label}: anchor not found")
    return text.replace(old, new, 1)


# 1) Phone touch PTT: BackgroundAudioService owns the transaction.
p = Path("android-native/app/src/main/java/com/reedersystems/commandcomms/ui/radio/RadioViewModel.kt")
s = p.read_text()
old = '''        Log.d(TAG, "onPttDown roomKey=${channel.roomKey}")
        app.signalingRepository.transmitPre(channel.roomKey)
        _uiState.update { it.copy(pttState = PttState.TRANSMITTING) }
        app.toneEngine.playTalkPermitTone()
        pttStartJob = viewModelScope.launch {
            sendServiceIntent(BackgroundAudioService.ACTION_PTT_DOWN)
        }'''
new = '''        Log.d(TAG, "onPttDown roomKey=${channel.roomKey}")
        if (com.reedersystems.commandcomms.BuildConfig.RADIO_DEVICE_TYPE == "android_phone") {
            _uiState.update { it.copy(pttState = PttState.CONNECTING) }
        } else {
            // Preserve existing handheld behavior for T320/other radio flavors.
            app.signalingRepository.transmitPre(channel.roomKey)
            _uiState.update { it.copy(pttState = PttState.TRANSMITTING) }
            app.toneEngine.playTalkPermitTone()
        }
        pttStartJob = viewModelScope.launch {
            sendServiceIntent(BackgroundAudioService.ACTION_PTT_DOWN)
        }'''
s = replace_one(s, old, new, "RadioViewModel PTT")
s = s.replace(
    "if (s.pttState == PttState.TRANSMITTING) {",
    "if (s.pttState == PttState.TRANSMITTING || s.pttState == PttState.CONNECTING) {",
    1,
)
p.write_text(s)

# 2) Signaling: canonical login identity + device-targeted floor grant + device-specific relay registration.
p = Path("src/services/signalingService.js")
s = p.read_text()
auth_old = '''    if (sessionUser) {
      validatedUnitId = sessionUser.unit_id || sessionUser.username || unitId;
      validatedUsername = sessionUser.username || username;
      validatedIsDispatcher = sessionUser.role === 'admin' || sessionUser.role === 'dispatcher' || false;
    }

    socket.unitId = validatedUnitId;'''
auth_new = '''    if (sessionUser) {
      validatedUnitId = sessionUser.unit_id || sessionUser.username || unitId;
      validatedUsername = sessionUser.username || username;
      validatedIsDispatcher = sessionUser.role === 'admin' || sessionUser.role === 'dispatcher' || false;
    } else {
      // Native Socket.IO may not carry the REST cookie. Resolve the claimed login
      // to the canonical database unit so sibling phone/T320 endpoints group together.
      try {
        const userResult = await pool.query(
          `SELECT id, username, unit_id, role FROM users
           WHERE username = $1 OR unit_id = $1 OR username = $2 OR unit_id = $2
           LIMIT 1`,
          [username, unitId]
        );
        if (userResult.rows.length > 0) {
          const canonicalUser = userResult.rows[0];
          validatedUnitId = canonicalUser.unit_id || canonicalUser.username || unitId;
          validatedUsername = canonicalUser.username || username;
          validatedIsDispatcher = canonicalUser.role === 'admin' || canonicalUser.role === 'dispatcher' || false;
          sessionUser = canonicalUser;
        }
      } catch (identityErr) {
        console.warn('[Signaling] Canonical native identity lookup failed:', identityErr.message);
      }
    }

    socket.unitId = validatedUnitId;'''
s = replace_one(s, auth_old, auth_new, "native auth")

grant_old = '''      socket.emit(RADIO_EVENTS.PTT_GRANTED, {
        channelId,
        senderUnitId: socket.unitId,
        timestamp: Date.now(),
      });'''
grant_new = '''      socket.emit(RADIO_EVENTS.PTT_GRANTED, {
        channelId,
        senderUnitId: socket.unitId,
        requestId: data.requestId || null,
        targetDeviceId: socket.deviceId || null,
        originSocketId: socket.id,
        timestamp: Date.now(),
      });'''
s = replace_one(s, grant_old, grant_new, "PTT grant")
s = s.replace(
    "audioRelayService.refreshSubscriber(ch, socket.unitId)",
    "audioRelayService.refreshSubscriber(ch, socket.deviceId || socket.unitId)",
)
s = s.replace(
    "audioRelayService.addSubscriber(channelId, socket.unitId, subscriberAddress, subscriberPort);",
    "audioRelayService.addSubscriber(channelId, socket.unitId, subscriberAddress, subscriberPort, socket.deviceId || null, socket.isRadioDevice ? 'radio' : (socket.deviceType || 'native'));",
)
s = s.replace(
    "audioRelayService.removeSubscriber(channelId, socket.unitId);",
    "audioRelayService.removeSubscriber(channelId, socket.deviceId || socket.unitId);",
)
s = s.replace(
    "const subscribedChannels = audioRelayService.getChannelsForSubscriber(socket.unitId);",
    "const subscribedChannels = audioRelayService.getChannelsForSubscriber(socket.deviceId || socket.unitId);",
)
# With device-keyed relay entries, disconnecting one sibling must remove only that device.
guard = '''    for (const channelId of subscribedChannels) {
      if (this._isUnitStillInChannel(socket.unitId, channelId, socket)) {
        console.log(`[Signaling] Skipping audio relay removal for ${socket.unitId} on ${channelId}: another device for the same unit is still present`);
        continue;
      }
      audioRelayService.removeSubscriber(channelId, socket.deviceId || socket.unitId);
    }'''
if guard in s:
    s = s.replace(
        guard,
        '''    for (const channelId of subscribedChannels) {
      audioRelayService.removeSubscriber(channelId, socket.deviceId || socket.unitId);
    }''',
        1,
    )
p.write_text(s)

# 3) Relay: subscribers keyed by physical device, grouped by unit.
p = Path("src/services/audioRelayService.js")
s = p.read_text()
start = s.index("  addSubscriber(channelId, unitId, address, port) {")
end = s.index("  setSignalingService(signalingService) {", start)
methods = '''  addSubscriber(channelId, unitId, address, port, deviceId = null, deviceType = null) {
    const key = canonicalChannelKey(channelId);
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Map());
    const subs = this.subscribers.get(key);
    let subscriberKey = deviceId || null;

    if (!subscriberKey) {
      for (const [candidateKey, candidate] of subs) {
        if (candidate.unitId === unitId && candidate.address === address && candidate.port === port) {
          subscriberKey = candidateKey;
          break;
        }
      }
    }

    // V1 radios do not carry deviceId. If signaling already registered exactly one
    // non-phone endpoint for this unit, bind/update that entry (including NAT changes).
    if (!subscriberKey) {
      const candidates = [...subs.entries()].filter(([, candidate]) =>
        candidate.unitId === unitId && candidate.deviceId && candidate.deviceType !== 'android_phone'
      );
      if (candidates.length === 1) subscriberKey = candidates[0][0];
    }

    if (!subscriberKey) subscriberKey = `legacy:${unitId}:${address}:${port}`;
    const existingSub = subs.get(subscriberKey);
    subs.set(subscriberKey, {
      unitId,
      deviceId: deviceId || existingSub?.deviceId || null,
      deviceType: deviceType || existingSub?.deviceType || null,
      address,
      port,
      lastSeen: Date.now(),
    });
  }

  refreshSubscriber(channelId, identifier) {
    const subs = this.subscribers.get(canonicalChannelKey(channelId));
    if (!subs) return false;
    const exact = subs.get(identifier);
    if (exact) {
      exact.lastSeen = Date.now();
      return true;
    }
    let refreshed = false;
    for (const sub of subs.values()) {
      if (sub.unitId === identifier) {
        sub.lastSeen = Date.now();
        refreshed = true;
      }
    }
    return refreshed;
  }

  removeSubscriber(channelId, identifier) {
    const key = canonicalChannelKey(channelId);
    const subs = this.subscribers.get(key);
    if (!subs) return;
    if (!subs.delete(identifier)) {
      for (const [subKey, sub] of [...subs]) {
        if (sub.unitId === identifier) subs.delete(subKey);
      }
    }
    if (subs.size === 0) this.subscribers.delete(key);
  }

  getChannelsForSubscriber(identifier) {
    const channels = [];
    for (const [channelId, subs] of this.subscribers) {
      if (subs.has(identifier) || [...subs.values()].some((sub) => sub.unitId === identifier)) {
        channels.push(channelId);
      }
    }
    return channels;
  }

  removeAllSubscriptions(identifier) {
    for (const [channelId, subs] of this.subscribers) {
      if (!subs.delete(identifier)) {
        for (const [subKey, sub] of [...subs]) {
          if (sub.unitId === identifier) subs.delete(subKey);
        }
      }
      if (subs.size === 0) this.subscribers.delete(channelId);
    }
  }

'''
s = s[:start] + methods + s[end:]

broadcast_old = '''      for (const [subUnitId, subInfo] of udpSubs) {
        if (subUnitId === senderUnitId) continue;
        try {
          this.socket.send(rxPayload, 0, rxPayload.length, subInfo.port, subInfo.address);
          udpSendCount++;
        } catch (err) {
          udpSendErrors++;
          console.error(`[AudioRelay] Send error to ${subUnitId}:`, err.message);
        }
      }'''
broadcast_new = '''      const sentEndpoints = new Set();
      for (const [subKey, subInfo] of udpSubs) {
        if ((subInfo.unitId || subKey) === senderUnitId) continue;
        const endpointKey = `${subInfo.address}:${subInfo.port}`;
        if (sentEndpoints.has(endpointKey)) continue;
        sentEndpoints.add(endpointKey);
        try {
          this.socket.send(rxPayload, 0, rxPayload.length, subInfo.port, subInfo.address);
          udpSendCount++;
        } catch (err) {
          udpSendErrors++;
          console.error(`[AudioRelay] Send error to ${subKey}:`, err.message);
        }
      }'''
s = replace_one(s, broadcast_old, broadcast_new, "relay UDP broadcast")
s = s.replace(
    "const { channelId: channelIdNumeric, sequence, opusPayload, flags, timestampMs, senderUnitId } = parsed;",
    "const { channelId: channelIdNumeric, sequence, opusPayload, flags, timestampMs, senderUnitId, senderDeviceId } = parsed;",
    1,
)
s = s.replace(
    "this.addSubscriber(channelKey, senderUnitId, rinfo.address, rinfo.port);",
    "this.addSubscriber(channelKey, senderUnitId, rinfo.address, rinfo.port, senderDeviceId || null);",
    1,
)

parser_pattern = re.compile(r'''    const version = msg\.readUInt8\(offset\); offset \+= VERSION_LEN;\n    if \(version !== PACKET_VERSION\) return null;\n    const flags = msg\.readUInt8\(offset\); offset \+= FLAGS_LEN;\n    const channelId = msg\.readUInt16BE\(offset\); offset \+= CHANNEL_ID_LEN;\n    const sequence = msg\.readUInt16BE\(offset\); offset \+= SEQUENCE_LEN;\n    const timestampMs = msg\.readUInt32BE\(offset\); offset \+= TIMESTAMP_LEN;\n    const senderLen = msg\.readUInt8\(offset\); offset \+= SENDER_LEN_LEN;\n    if \(msg\.length < offset \+ senderLen \+ PAYLOAD_LEN_LEN\) return null;\n    const senderUnitId = msg\.subarray\(offset, offset \+ senderLen\)\.toString\('utf8'\);\n    offset \+= senderLen;\n    const payloadLength = msg\.readUInt16BE\(offset\); offset \+= PAYLOAD_LEN_LEN;\n    if \(payloadLength < 0 \|\| msg\.length < offset \+ payloadLength\) return null;\n    const opusPayload = payloadLength > 0 \? msg\.subarray\(offset, offset \+ payloadLength\) : Buffer\.alloc\(0\);\n    return \{ channelId, sequence, timestampMs, flags, senderUnitId, opusPayload \};''')
parser_new = '''    const version = msg.readUInt8(offset); offset += VERSION_LEN;
    if (version !== 1 && version !== 2) return null;
    const flags = msg.readUInt8(offset); offset += FLAGS_LEN;
    const channelId = msg.readUInt16BE(offset); offset += CHANNEL_ID_LEN;
    const sequence = msg.readUInt16BE(offset); offset += SEQUENCE_LEN;
    const timestampMs = msg.readUInt32BE(offset); offset += TIMESTAMP_LEN;
    const senderLen = msg.readUInt8(offset); offset += SENDER_LEN_LEN;
    if (msg.length < offset + senderLen + PAYLOAD_LEN_LEN) return null;
    const senderUnitId = msg.subarray(offset, offset + senderLen).toString('utf8');
    offset += senderLen;
    let senderDeviceId = null;
    if (version === 2) {
      if (msg.length < offset + 1 + PAYLOAD_LEN_LEN) return null;
      const deviceLen = msg.readUInt8(offset); offset += 1;
      if (msg.length < offset + deviceLen + PAYLOAD_LEN_LEN) return null;
      senderDeviceId = deviceLen > 0 ? msg.subarray(offset, offset + deviceLen).toString('utf8') : null;
      offset += deviceLen;
    }
    const payloadLength = msg.readUInt16BE(offset); offset += PAYLOAD_LEN_LEN;
    if (msg.length < offset + payloadLength) return null;
    const opusPayload = payloadLength > 0 ? msg.subarray(offset, offset + payloadLength) : Buffer.alloc(0);
    return { channelId, sequence, timestampMs, flags, senderUnitId, senderDeviceId, opusPayload };'''
s, count = parser_pattern.subn(parser_new, s, count=1)
if count != 1:
    raise SystemExit("relay parser anchor missing")

# Subscriber sweep map key is now device identity; notifications still use unit identity.
s = replace_one(
    s,
    "      for (const [unitId, sub] of subs) {",
    "      for (const [subscriberKey, sub] of subs) {\n        const unitId = sub.unitId || subscriberKey;",
    "subscriber sweep loop",
)
s = replace_one(
    s,
    "          subs.delete(unitId);\n          console.log(`[AudioRelay] SUBSCRIBER_STALE_REMOVED unitId=${unitId}",
    "          subs.delete(subscriberKey);\n          console.log(`[AudioRelay] SUBSCRIBER_STALE_REMOVED key=${subscriberKey} unitId=${unitId}",
    "subscriber sweep delete",
)
p.write_text(s)

# 4) UDP packet v2 for PHONE only; other flavors stay V1.
p = Path("android-native/app/src/main/java/com/reedersystems/commandcomms/audio/radio/UdpAudioTransport.kt")
s = p.read_text()
s = replace_one(s, "private const val PACKET_VERSION: Byte = 1", "private const val PACKET_VERSION: Byte = 1\nprivate const val PACKET_VERSION_DEVICE: Byte = 2", "UDP version")
s = replace_one(s, '    var unitId: String = ""\n    var onPacketReceived:', '    var unitId: String = ""\n    var deviceId: String = ""\n    var onPacketReceived:', "UDP device property")
start = s.index("    private fun framePacket(audioData: ByteArray): ByteArray {")
end = s.index("    private fun startReceiveLoop()", start)
frame = '''    private fun framePacket(audioData: ByteArray): ByteArray {
        val seq = sequenceNumber++
        val senderBytes = unitId.toByteArray(Charsets.UTF_8)
        val senderLen = senderBytes.size.coerceAtMost(255)
        val deviceBytes = deviceId.toByteArray(Charsets.UTF_8)
        val deviceLen = deviceBytes.size.coerceAtMost(255)
        val useDeviceVersion = deviceLen > 0
        val timestampMs = (System.currentTimeMillis() and 0xFFFFFFFFL).toInt()
        val frame = ByteArray(RADIO_HEADER_FIXED_LEN + senderLen + (if (useDeviceVersion) 1 + deviceLen else 0) + audioData.size)
        var offset = 0
        frame[offset++] = if (useDeviceVersion) PACKET_VERSION_DEVICE else PACKET_VERSION
        frame[offset++] = FLAG_FEC_HINT.toByte()
        frame[offset++] = ((channelIndex shr 8) and 0xFF).toByte()
        frame[offset++] = (channelIndex and 0xFF).toByte()
        frame[offset++] = ((seq shr 8) and 0xFF).toByte()
        frame[offset++] = (seq and 0xFF).toByte()
        frame[offset++] = ((timestampMs shr 24) and 0xFF).toByte()
        frame[offset++] = ((timestampMs shr 16) and 0xFF).toByte()
        frame[offset++] = ((timestampMs shr 8) and 0xFF).toByte()
        frame[offset++] = (timestampMs and 0xFF).toByte()
        frame[offset++] = senderLen.toByte()
        System.arraycopy(senderBytes, 0, frame, offset, senderLen)
        offset += senderLen
        if (useDeviceVersion) {
            frame[offset++] = deviceLen.toByte()
            System.arraycopy(deviceBytes, 0, frame, offset, deviceLen)
            offset += deviceLen
        }
        frame[offset++] = ((audioData.size shr 8) and 0xFF).toByte()
        frame[offset++] = (audioData.size and 0xFF).toByte()
        System.arraycopy(audioData, 0, frame, offset, audioData.size)
        return frame
    }

'''
s = s[:start] + frame + s[end:]
p.write_text(s)

p = Path("android-native/app/src/main/java/com/reedersystems/commandcomms/audio/BackgroundAudioService.kt")
s = p.read_text()
anchor = '        engine.udpTransport.unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: ""\n'
s = replace_one(
    s,
    anchor,
    anchor + '        engine.udpTransport.deviceId = if (com.reedersystems.commandcomms.BuildConfig.RADIO_DEVICE_TYPE == "android_phone") app.signalingClient.deviceId.orEmpty() else ""\n',
    "background UDP identity",
)
p.write_text(s)

# Phone-only version bump.
p = Path("android-native/app/build.gradle.kts")
s = p.read_text()
s = replace_one(
    s,
    '            versionCode = 6\n            versionNameSuffix = "-phone-v6"',
    '            versionCode = 7\n            versionNameSuffix = "-phone-v7"',
    "phone version",
)
p.write_text(s)
