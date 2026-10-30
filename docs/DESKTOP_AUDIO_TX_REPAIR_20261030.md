# Desktop TX static and Opus/PCM framing repair

Status: implementation branch, not deployed or field-verified.
Date: 2026-10-30

## Incident and reproduction evidence
Windows Sound Recorder on the same computer captures understandable speech with background air/hiss. Command Communications desktop PTT makes the same speech nearly unintelligible under very loud static/garbling. Lowering transmit volume does not resolve it.

Repository investigation traced the path:
Desktop mic -> AudioContext -> pcm-capture-worklet (or ScriptProcessor) -> 16k PCM -> WebCodecs Opus -> binary WS marker 0x02 -> wsAudioBridge -> audioRelayService -> radio packet UDP -> Android JitterBuffer -> AudioPlayback.

## Confirmed code defects addressed
1. Capture worklet previously treated every 320 audio-context samples as 20 ms of 16 kHz audio, even when the actual AudioContext sample rate was higher. This would label 6.67 ms of 48 kHz input as 20 ms, tripling the sender frame rate, causing backlogs and unintelligible audio. It is conditional on actual AudioContext rate and still needs a live field measurement.
2. audioRelayService and native Android AudioPlayback treated compressed payloads beginning with byte 0x01 as uncompressed PCM. RFC 6716 permits Opus packets with 0x01 TOC. This was an unequivocal codec identification bug and could inject raw compressed bytes into PCM playback.
3. Desktop capture had no explicit input device chooser and disabled acoustic echo cancellation. The actual microphone path could differ from Windows Sound Recorder.

## Fix
- Desktop AudioWorklet and ScriptProcessor fallback convert the measured AudioContext rate to a continuous 16 kHz stream, one 320-sample mono s16 frame per 20 ms. A voice-passband prefilter is used when downsampling.
- UI adds persistent desktop microphone input selection. Capture is refreshed on device changes, without interrupting an active PTT transmission. Invalid explicit device IDs do not silently switch to an unintended microphone.
- Microphone output is deliberately silent in AudioWorklet and fallback processor. Desktop microphone getUserMedia requests echo cancellation.
- Browser Opus encoder requests the WebCodecs voice profile, 20 ms raw Opus frames, and in-band FEC. For older Electron/Chromium engines, falls back to supported baseline configuration; outgoing frames are checked for 20 ms TOC duration before transmission.
- Relay and Android distinguish PCM fallback only through bit 2 (0x04) of the existing radio packet flags field. Unflagged payloads are Opus regardless of their first byte; the Android jitter buffer keeps the flag attached to its frame while reordering and FEC processing.
- Android emergency PCM fallback is normalized to 20 ms at 16 kHz before sending. It retains the existing one-byte PCM fallback prefix **only when** the explicit codec bit is set. The backend and native parser reject malformed flagged PCM.
- TX diagnostic logs record source audio rate, active microphone device, frame RMS, peak, clipping, Opus bytes and packet duration. They do not log voice content.

## Compatibility and rollout
- Existing radio UDP header length and wire versions 1/2 remain unchanged; bit 2 of flags is newly defined.
- New ordinary Opus packets are compatible with existing radios, but older Android receivers can still misinterpret a valid Opus 0x01 TOC. Upgrade the native receiving APKs before declaring the end-to-end defect resolved.
- Legacy Android senders that produce unflagged emergency PCM fallback are no longer interpreted as PCM by updated receivers. Treat this as a coordinated radio APK/backend release. The old behavior was ambiguous and could emit loud digital noise; dropping an unsupported fallback is safer than playing compressed bytes as PCM.
- iOS continues its existing Opus-only receive contract; emergency PCM fallback was not supported on that client before this change.
- Radio-to-radio ordinary Opus, AI dispatcher speech, scanner feeds, CAD and cross-device routing are intentionally unchanged.
- No database, tenant, authorization, emergency/floor-control, or dispatch schema changes.

## Validation gates
- Targeted tests: 16 kHz, 44.1 kHz and 48 kHz capture resampling; 20 ms TOC parsing; true Opus encode/decode; first-byte 0x01 classification; flagged PCM acceptance/rejection; PTT microphone switching; existing Opus encoder/PTT/relay sibling tests.
- Browser client production build; Android SD7 compile/build (native source shared by SD7/HD760/T320).
- Field: compare Windows Sound Recorder and in-app TX using the **same selected input**. Verify desktop->desktop, desktop->radio, radio->desktop, radio->radio, same-unit sibling and bridged radio paths. Test talk/listen with an open speaker, then headset; confirm zero feedback and intelligible voice.
- Inspect logs for `CAPTURE_RATE`, `WORKLET_CAPTURE_CONFIG`, `AUDIO_TX_PCM_DIAG`, `AUDIO_TX_OPUS_PACKET`, `AUDIO_TX_BAD_OPUS_DURATION`, `INVALID_FLAGGED_PCM_PACKET`, `pcmFallback`, and `OPUS_DECODE_ERROR`. In a healthy ordinary desktop Opus transmission, `pcmFallback=false`.
- Failure cases: unplugged selected mic, reconnect, delayed PTT release, forced encoder failure/PCM fallback, inactive radio, packet reorder/loss and a valid Opus TOC 0x01.
- Review deployment separately. No merge, APK distribution, backend restart, desktop release or production deployment without owner approval.

## Rollback
If live testing fails, revert the coordinated change set across backend, desktop and native client together. Do not roll back codec bits on only one side while leaving mixed app versions unverified.
