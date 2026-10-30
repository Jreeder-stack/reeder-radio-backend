# Command Communications HD760 audio reliability checkpoint (2026-10-30)

## Source and ownership

- Repository: `Jreeder-stack/reeder-radio-backend`
- Base `main` at investigation: `1c9a5d6df338dddf7b1333adb4ba1c477713194e`
- Branch: `fix/hd760-audio-reliability-20261030`
- Validated executable branch commit: `2cc1e7bd931783933acaaba32847a1162a68fa92` (workflow trigger changed after source commits)
- GitHub Actions build: [41057676349](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/41057676349)
- Job: `124069212978`, SUCCESS; Node 20 relay/native-page tests, desktop UI build, HD760 Android unit tests and APK assembly succeeded
- HD760 debug APK artifact: `12978001776` (`command-comms-hd760-radio-debug`)
- AI Dispatcher V3 remains isolated in draft PR [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163); **do not reimplement V3** here

## Findings and repair scope

| ID | Investigation / source repair | Coded | CI | Physical validation |
| --- | --- | --- | --- | --- |
| HD760-REL-01 | MediaPlayer completion/error/stop waiting was unbounded after the HD760 floor grant. Bounded permit gate, truthful oscillator fallback and exception/floor cleanup; restore RX on denied and failed PTT. | Yes | Passed | Pending |
| HD760-REL-02 | UDP `trySend` failure was silently ignored, queued audio could survive socket restart, TX heartbeat treated enqueue as transmission, and quiet channels triggered RX socket recreation. Return queue acceptance; reject stale/old-generation frames; base heartbeat on actual UDP sends; limit receive recovery to actively expected remote audio. | Yes | Passed | Pending |
| HD760-REL-03 | HD760 TX bars had no measured TX signal, RX indicator depended on signaling state, and speaker route for injected audio depended on `tx:start`. Derive TX/RX activity and bars from capture/accepted media/PCM; activate HD760 speaker route on accepted RX packets and release it after burst idle. | Yes | Passed | Pending |
| HD760-REL-04 | V3 injected speech does not yet explicitly propagate the ordinary TX start/stop events. Coordinate with V3's single outbound scheduler in PR #163; do not introduce parallel speech workers or weaken floor/tenant authorization. | No | Not run | Pending |
| HD760-REL-05 | Full Android flavor/desktop backend regression and physical HD760↔T320/AI multi-minute soak, including screen-off, rapid PTT, reconnect, and feedback diagnostics. | No | HD760 only | Pending |

## Physical acceptance sequence (not yet performed)

1. Install the branch's HD760 APK on the test HD760 only. Confirm registration, unit identity, authenticated channel join, microphone permission, and correct selected zone/channel.
2. On the same **authorized** channel, alternate at least 20 HD760-to-T320 and 20 T320-to-HD760 PTT exchanges. Speak **after** the HD760 talk-permit tone, and confirm displayed TX activity corresponds to actual microphone capture, with moving audio bars.
3. Repeat in background/screen-off mode and test quick re-press after release. Verify no stuck floor, self-audio, permanent receive suspension, or orphaned outgoing audio after release/restart.
4. Have AI Dispatcher respond to 10 addressed HD760 hails. Compare audio heard on the desktop with the HD760's RX display and audible speaker output. Separately record failures to transcribe/respond vs replies audible only on desktop.
5. Repeat testing over at least 10 minutes, including ordinary idle gaps, a network reconnection, and scanned/primary channels where authorized. Confirm no intermittent RX silence or significant audio breakup.
6. If anything fails, capture device logcat **before reboot** and backend audio relay logs at the matching timestamp. Record the selected channel, source/target units, and whether the desktop played the same burst.

Useful existing diagnostic markers:

- HD760: `CC-HD760`, `TPT_START`, `TPT_COMPLETE_MIC_OPEN`, `TPT_OR_MIC_START_FAILED`, `PTT_STATE`, `PCM_SUMMARY`, `TX_QUEUE_FULL`, `TX_QUEUE_STALE_DROP`, `TX_HEARTBEAT_STALL`, `RX_DIAG`, `RADIO_ROUTE_APPLIED`, `RX_WATCHDOG_EXPECTED_AUDIO_MISSING`, `LATENCY_FIRST_RX_FRAME_DECODED`, `WRITE_SUMMARY`.
- Server: `KEEPALIVE_OK`, `SUBSCRIBER_REGISTERED`, `UDP_DELIVERY`, `RELAY_CHANNEL_ID_ZERO`, `WS_PACING_FRAME_DROPPED`, `WS_PACING_BURST`.

On Windows, run `adb logcat -v threadtime > hd760-audio-test.log` before the test, stop with Ctrl+C after the failure, and redact credentials/private speech metadata before sharing.

## Limitations, safety and rollback

- This is **coding plus scoped CI acceptance**, not verification of a live physical fix.
- The shared Android transport and playback classes also affect T320, SD7 and phone flavors; compile/runtime regression beyond the HD760 workflow is still outstanding.
- Choppy audio affecting *all* devices and desktop requires contemporaneous packet/relay evidence; absence of that evidence is not proof of a particular server root cause.
- No CAD schema, authorization, emergency policy, provider, codec, radio firmware, production service, deployment or PR #163 code has been changed.
- The branch must stay unmerged and un-deployed until owner approval. Rollback is to retain the currently deployed release; a pilot can restore its previously installed HD760 APK.
