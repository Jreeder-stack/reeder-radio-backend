# HD760 channel-catalog auto retry (2026-10-31)

## Evidence and cause
- Reported radio screen displayed NO ZONE / NO CHANNEL with `Unable to resolve host "comms.reeder-systems.com"`, while physical PTT could still transmit.
- Native `ChannelRepository.getChannels()` calls the authorized `GET /api/channels` endpoint. `RadioViewModel.loadChannels()` previously ran this once, set an error on failure, and never retried. The view model has an empty zone list after DNS failure.
- Hardware PTT is handled independently by `BackgroundAudioService`, which uses `ServiceConnectionPrefs` with the previously saved room key. Thus a working background TX may coexist with a blank UI channel catalog.
- The screenshot does not establish whether the public DNS record, the radio's DNS resolver, or the network was the underlying cause of that particular lookup failure. This change improves client recovery; it does not modify DNS.

## Implementation
- HD760-only retry of transient DNS/network errors and HTTP 408/429/5xx, using a single view-model coroutine and delays of 2, 5, 10, 20 then 30 seconds capped indefinitely until success or view-model destruction.
- Stop retrying on HTTP 4xx (except 408/429), malformed responses, and other programming errors. No authentication bypass or stale catalog accepted.
- When the fresh authorized catalog arrives, restore the background service's saved channel only if both unit ID and exact numeric ID plus room key match an authorized channel in that fresh catalog. Do not blindly select channel one or restart the audio service.
- If the knob moved during an outage, use the changed selection only when PTT is idle. Do not overwrite an active service channel due solely to catalog restoration.
- Show RETRYING when the catalog fetch is waiting to retry, and NO CHANNEL instead of green ONLINE when signaling is authenticated but there is no selected channel.
- Other Android flavors, PTT transport, codec, emergency handling, backend DNS and V3 dispatcher are unchanged.

## Validation/rollback
- `Hd760ChannelRecoveryTest` asserts DNS/timeouts/5xx retry, unauthorized or malformed response rejection, capped delays, same-unit/exact-room-key selection, and foreign-unit rejection.
- Existing HD760 CI: `:app:testHd760DebugUnitTest :app:assembleHd760Debug` plus relay and desktop UI checks.
- Physical acceptance required: install new APK on test HD760, show outage then recovery on Wi-Fi/cellular, verify remembered on-air channel displayed and no PTT interruption, validate PTT after reconnect, repeated outages, denied token and missing authorization.
- Do not merge/deploy until owner approval. Backout: install previous HD760 APK; the retry does not migrate stored preferences.
