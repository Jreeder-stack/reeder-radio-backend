# HD760 persistent per-radio channel programming (2026-10-31)

## Purpose
The HD760 must retain its own assigned lineup (zone/channel names and numeric IDs) in a local, durable program. Once the radio has been programmed online, the operator can view zones, change the rotary position, and power-cycle in airplane mode without a backend. PTT must **not** transmit without an authenticated live channel.

## Authority and server changes
- Existing user/unit `user_channel_access` is the maximum permission. The per-radio custom list only narrows it.
- Each `radios` row has `custom_channel_programming` (default false). A new `radio_channel_programming` table holds ordered per-radio channel IDs. False means inherit all currently authorized unit channels; true plus zero rows means intentionally no channels.
- On reassignment to another user, previously customized channel IDs are deleted and the radio inherits the new user's authorized channels. Lock/unassignment continue to use existing authentication and signaling controls.
- Authenticated radio-token `GET /api/channels` uses the actual backend radio assignment, applies server authorization and custom filtering, and never substitutes an unrelated browser cookie.
- Radio Management provides **Program channels**, supporting unit defaults and a custom ordered subset. `GET/PUT /api/radios/:radioId/channels` requires dispatcher/admin session authorization; writes validate all selected IDs and use an assignment-checked database transaction.
- An online radio receives `radio:channels_updated`, relinquishes old channel memberships/floors and refetches; existing signaling authorization also restricts the radio token's `radio:joinChannel` and legacy channel-join path to the programmed subset.
- This adds a database table and column. **No production migration or deployment was performed.**

## HD760 local behavior
- The new HD760-only `hd760_channel_lineup` SharedPreferences snapshot contains only channel metadata plus physical radio ID, assigned unit identity and format version, not credentials. Cached data is validated and isolated to the same radio and unit.
- On startup, display cached zones and the saved knob/channel immediately, before any network request. Previously saved per-zone rotary programming is available while offline. A missing cache shows no channels until the first successful provision.
- After a successful authenticated channel response, atomically save the new lineup to device-private storage, align the per-zone knob slots to server programming when changed, and refresh display. The prior retry flow remains in place for network/DNS/408/429/5xx failures (2/5/10/20/30-second capped backoff).
- A DNS outage does not erase the saved lineup; the footer reads OFFLINE, and the radio displays SAVED CHANNELS. Once connected, new server changes replace it.
- Verified lock, unassignment, reassignment, token rejection, and server-confirmed channel removal invalidate stale local programming and stop stale service selection. A channel update during TX does not silently move the active transmission.
- HD760 PTT service now requires signaling even if started through a non-hardware code path. Offline lineup data is **never** an authorization grant.
- Other Android flavors retain their prior channel-loading and PTT behavior.

## Operator test
1. Using Radio Management, assign HD760 radio to a unit with authorized channels, then select **Program channels** and customize the radio if desired.
2. Install new build and start the HD760 online. Confirm ZN/CH names, knob positions, and ordinary authorized TX/RX.
3. Turn off Wi-Fi and cellular/enable airplane mode. Confirm offline status, saved channel/zone names, knob selections and PTT denial.
4. Completely power off and restart without signal. Confirm the same cached lineup and positions before any network response.
5. Restore service. Confirm automatic channel synchronization and authorized TX/RX without reinstalling the app.
6. In Radio Management, remove one custom channel and change channel order. Confirm that the radio updates its knob slots, cannot join the removed channel and can use its newly authorized list.
7. Test two radios on the same unit with different custom lists; verify each caches only its own program and cannot load the other's cache.
8. Test reassignment, lock, invalid token, explicit zero-channel programming, and transient DNS/500 failures. Verify cached display is preserved on network failures, but server-confirmed restrictions are applied on reconnect.

## Limitations and rollback
- Offline visibility requires at least one successful authenticated programming download. An offline radio cannot learn newer changes until it reconnects; it cannot TX while offline.
- Existing hardware offers 16 rotary detents per zone. Channels beyond 16 in one zone are not reachable by the 16-position knob.
- Android builds and mocked backend tests are not a substitute for actual HD760 network-loss/power-cycle testing and production PostgreSQL migration acceptance.
- No merge, deployment, firmware rewrite, codec changes, emergency control relaxation, or AI Dispatcher V3 changes.
- Roll back by retaining the previous backend/app release and reinstalling its APK if needed. The new programming table is additive; do not delete the table or its assignments during rollback.
