# Command Communications — External CAD API Reference

> **This document must be updated whenever API changes are made.**

`last_updated: 2026-04-11T12:00:00Z`

---

## Table of Contents

1. [Authentication](#authentication)
2. [Base URL & Rate Limits](#base-url--rate-limits)
3. [Standard Response Format](#standard-response-format)
4. [CAD Integration Endpoints](#cad-integration-endpoints) (`/api/cad-integration/*`)
5. [Auth Endpoints](#auth-endpoints) (`/api/auth/*`)
6. [Dispatch Endpoints](#dispatch-endpoints) (`/api/dispatch/*`)
7. [PTT Endpoints](#ptt-endpoints) (`/api/ptt/*`)
8. [Channel Endpoints](#channel-endpoints) (`/api/channels/*`)
9. [Location Endpoints](#location-endpoints) (`/api/location/*`)
10. [Message Endpoints](#message-endpoints) (`/api/messages/*`)
11. [Unit Endpoints](#unit-endpoints) (`/api/unit/*`)
12. [Radio Config Endpoints](#radio-config-endpoints) (`/api/radio/*`)
13. [Recording Log Endpoints](#recording-log-endpoints) (`/api/recording-logs/*`)
14. [Admin Endpoints](#admin-endpoints) (`/api/admin/*`)
15. [Internal CAD Proxy Endpoints](#internal-cad-proxy-endpoints) (`/api/cad/*`)
16. [Socket.IO Signaling](#socketio-signaling)
17. [Audio WebSocket](#audio-websocket)
18. [Embeddable Radio Client](#embeddable-radio-client)
19. [Changelog / Maintenance](#changelog--maintenance)

---

## Authentication

There are two authentication mechanisms available for external CAD systems:

### 1. API Key Authentication

Most CAD Integration endpoints require an API key sent via the `x-radio-api-key` HTTP header. The key must match the `CAD_INTEGRATION_KEY` environment variable configured on the radio server.

| Header | Value |
|---|---|
| `x-radio-api-key` | Your shared `CAD_INTEGRATION_KEY` value |

Alternatively, the API key can be passed in the JSON request body as `"apiKey"`.

### 2. Session-Based Authentication (CAD Login)

For endpoints that require a user session (e.g., dispatch, PTT, internal CAD proxy), your CAD backend must first establish a session:

1. Call `POST /api/auth/cad-login` with the API key and a username.
2. The response sets a `connect.sid` session cookie (signed, HTTP-only).
3. Include the `connect.sid` cookie in all subsequent requests from that user's session.

The session cookie is:
- **Name:** `connect.sid`
- **Signed:** Yes (using the server's `SESSION_SECRET`)
- **HTTP-Only:** Yes
- **SameSite:** `none` in production, `lax` in development
- **Secure:** `true` in production
- **Max-Age:** 24 hours

### Auth Modes Summary

| Auth Mode | How | Used By |
|---|---|---|
| API Key only | `x-radio-api-key` header | `/api/cad-integration/verify-user`, `/api/cad-integration/unit/:unitId/*`, `/api/cad-integration/ptt-status`, `/api/cad-integration/units` |
| API Key or Session | `x-radio-api-key` header **or** `connect.sid` cookie | `/api/cad-integration/zones`, `/api/cad-integration/channels` |
| API Key + Session creation | `x-radio-api-key` header (creates session) | `POST /api/auth/cad-login` |
| Session required | `connect.sid` cookie | `/api/dispatch/*` (except `/health`), `/api/ptt/*`, `/api/channels/*`, `/api/cad/*`, `/api/unit/*`, `/api/radio/*` |
| Session + Dispatcher role | `connect.sid` cookie (dispatcher) | `/api/messages/export/audio`, `/api/recording-logs/*` |
| Session + Admin role | `connect.sid` cookie (admin) | `/api/admin/*` |
| No auth | None | `/api/dispatch/health`, `/api/location/*`, `/api/messages/*` (except `export/audio`) |

---

## Base URL & Rate Limits

| Setting | Value |
|---|---|
| **Base URL** | Your deployed radio server URL (e.g., `https://your-radio-server.replit.app`) |
| **Content-Type** | `application/json` for all request/response bodies |
| **CAD Integration Rate Limit** | 200 requests per 15-minute window on `/api/cad-integration/*` |
| **Auth Rate Limit** | 100 requests per 15-minute window on `/api/auth/*` |

When rate-limited, the server responds with:
```json
{ "error": "Too many requests" }
```

---

## Standard Response Format

### Success

```json
{
  "success": true,
  "data": { ... }
}
```

HTTP status: `200` (or `201` for resource creation)

### Error

```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

or

```json
{
  "success": false,
  "message": "Description of what went wrong"
}
```

### Implementation Notes

The actual response shape varies slightly by endpoint family:

- **CAD Integration, Auth, Dispatch, Channels, Radio Config, Admin** endpoints use a `success()` helper that sends the data object directly (e.g., `{ "zones": [...] }` rather than wrapping in `{ "success": true, "data": { "zones": [...] } }`). Errors are returned as `{ "error": "..." }`.
- **Unit** (`/api/unit/*`), **Internal CAD proxy** (`/api/cad/*`), **Messages** (`/api/messages/*`), and **Recording Logs** (`/api/recording-logs/*`) endpoints use explicit `{ "success": true|false, ... }` patterns.
- **PTT and Dispatch helpers** return `{ "success": true }` directly for simple confirmations.

The individual endpoint sections below show the **exact** response shapes returned by each endpoint.

### Common HTTP Status Codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Created (some dispatch endpoints) |
| `400` | Bad request / missing fields |
| `401` | Not authenticated / API key missing |
| `403` | Forbidden / invalid API key or blocked account |
| `404` | Resource not found |
| `409` | Conflict (e.g., channel busy during PTT) |
| `500` | Server error |
| `503` | Service unavailable (e.g., signaling not ready) |

---

## CAD Integration Endpoints

All endpoints are under `/api/cad-integration`. These use the `success(res, data)` helper which sends data directly as JSON.

### POST `/api/cad-integration/verify-user`

Verify whether a username exists and retrieve basic user info.

- **Auth:** API Key required (`x-radio-api-key`)
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | string | Yes | The username to verify |

- **Success Response (user exists):**

```json
{
  "exists": true,
  "username": "officer1",
  "unit_id": "U-101",
  "role": "user",
  "is_dispatcher": false
}
```

- **Success Response (user does not exist):**

```json
{
  "exists": false,
  "username": "nonexistent"
}
```

- **curl:**

```bash
curl -X POST https://<host>/api/cad-integration/verify-user \
  -H "x-radio-api-key: <YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"username":"officer1"}'
```

---

### GET `/api/cad-integration/zones`

Returns all zones with their nested channels.

- **Auth:** API Key **or** Session
- **Request Body:** None
- **Success Response:**

```json
{
  "zones": [
    {
      "id": 1,
      "name": "North",
      "channels": [
        {
          "id": 1,
          "name": "Dispatch",
          "zone": "North",
          "enabled": true,
          "room_key": "North__Dispatch"
        }
      ]
    }
  ]
}
```

- **curl:**

```bash
curl https://<host>/api/cad-integration/zones \
  -H "x-radio-api-key: <YOUR_KEY>"
```

---

### GET `/api/cad-integration/channels`

Returns all enabled channels, optionally filtered by zone.

- **Auth:** API Key **or** Session
- **Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `zone` | string | No | Filter channels by zone name |

- **Success Response:**

```json
{
  "channels": [
    {
      "id": 1,
      "name": "Dispatch",
      "zone": "North",
      "room_key": "North__Dispatch"
    }
  ]
}
```

- **curl:**

```bash
curl "https://<host>/api/cad-integration/channels?zone=Patrol" \
  -H "x-radio-api-key: <YOUR_KEY>"
```

---

### GET `/api/cad-integration/unit/:unitId/zones`

Returns only the zones and channels the specified unit has access to.

- **Auth:** API Key required
- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `unitId` | string | The unit ID to look up |

- **Success Response:**

```json
{
  "unitId": "U-101",
  "zones": [
    {
      "id": 1,
      "name": "North",
      "channels": [
        {
          "id": 1,
          "name": "Dispatch",
          "zone": "North",
          "enabled": true,
          "room_key": "North__Dispatch"
        }
      ]
    }
  ]
}
```

- **Error Response (unit not found, HTTP 404):**

```json
{
  "error": "Unit not found"
}
```

- **curl:**

```bash
curl https://<host>/api/cad-integration/unit/U-101/zones \
  -H "x-radio-api-key: <YOUR_KEY>"
```

---

### GET `/api/cad-integration/unit/:unitId/channels`

Returns channels assigned to the specified unit, grouped by zone.

- **Auth:** API Key required
- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `unitId` | string | The unit ID to look up |

- **Success Response:**

```json
{
  "unitId": "U-101",
  "channelsByZone": [
    {
      "zoneId": 1,
      "zoneName": "North",
      "channels": [
        {
          "id": 1,
          "name": "Dispatch",
          "zone": "North",
          "enabled": true,
          "room_key": "North__Dispatch"
        }
      ]
    }
  ]
}
```

- **curl:**

```bash
curl https://<host>/api/cad-integration/unit/U-101/channels \
  -H "x-radio-api-key: <YOUR_KEY>"
```

---

### GET `/api/cad-integration/ptt-status`

Returns the current PTT floor state across all channels (who is currently transmitting).

- **Auth:** API Key required
- **Success Response:**

```json
{
  "activeTransmissions": [
    {
      "channelId": "North__Dispatch",
      "unitId": "U-101",
      "username": "officer1",
      "startTime": 1712764800000,
      "isEmergency": false
    }
  ]
}
```

- **curl:**

```bash
curl https://<host>/api/cad-integration/ptt-status \
  -H "x-radio-api-key: <YOUR_KEY>"
```

---

### GET `/api/cad-integration/units`

Returns all currently online units with presence info.

- **Auth:** API Key required
- **Success Response:**

```json
{
  "units": [
    {
      "unitId": "U-101",
      "username": "officer1",
      "status": "online",
      "channels": ["North__Dispatch"],
      "lastSeen": 1712764800000,
      "isDispatcher": false
    }
  ]
}
```

- **curl:**

```bash
curl https://<host>/api/cad-integration/units \
  -H "x-radio-api-key: <YOUR_KEY>"
```

---

## Auth Endpoints

### POST `/api/auth/cad-login`

Establishes a session for a CAD user. This is how external CAD systems authenticate users without a password — the shared API key acts as the trust boundary.

- **Auth:** API Key required (`x-radio-api-key` header)
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | string | Yes | The username to log in |

- **Success Response (HTTP 200):**

```json
{
  "user": {
    "id": 1,
    "username": "officer1",
    "email": "officer1@dept.gov",
    "role": "user",
    "unit_id": "U-101",
    "is_dispatcher": false
  }
}
```

The response also sets the `connect.sid` session cookie.

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "Username is required" }` | Missing `username` |
| `403` | `{ "error": "Account is blocked" }` | Account is blocked |
| `404` | `{ "error": "User not found" }` | User not found |

- **curl:**

```bash
curl -X POST https://<host>/api/auth/cad-login \
  -H "x-radio-api-key: <YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"username":"officer1"}' \
  -c cookies.txt
```

---

### GET `/api/auth/me`

Returns the currently authenticated user based on the session cookie. Refreshes user data from the database.

- **Auth:** Session required (`connect.sid` cookie)
- **Success Response:**

```json
{
  "user": {
    "id": 1,
    "username": "officer1",
    "email": "officer1@dept.gov",
    "role": "user",
    "unit_id": "U-101",
    "is_dispatcher": false
  }
}
```

- **Error Response (not authenticated, HTTP 401):**

```json
{
  "error": "Not authenticated"
}
```

---

## Dispatch Endpoints

All endpoints are under `/api/dispatch`. These use the `success(res, data)` helper which sends data directly.

### GET `/api/dispatch/health`

Health check endpoint. **No auth required.**

- **Response:**

```json
{
  "status": "ok",
  "timestamp": 1712764800000
}
```

---

### GET `/api/dispatch/health/detailed`

Detailed system health including signaling stats.

- **Auth:** Session required
- **Response:**

```json
{
  "signalingConnected": true,
  "audioTransportAvailable": true,
  "activeTransmissions": 0,
  "activeEmergencies": 0,
  "connectedUnits": 5,
  "channelCount": 3,
  "timestamp": 1712764800000
}
```

---

### GET `/api/dispatch/connection-stats`

Returns connection statistics for all units.

- **Auth:** Session required
- **Response:**

```json
{
  "stats": [
    {
      "unitId": "U-101",
      "channelId": "North__Dispatch",
      "totalMs": 360000,
      "connectionCount": 5,
      "lastConnection": 1712764800000,
      "avgConnectionMs": 72000
    }
  ]
}
```

---

### POST `/api/dispatch/connection-time`

Record a connection time for a unit on a channel.

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `unitId` | string | No | Falls back to session user's unit_id/username |
| `channelId` | string | Yes | Channel identifier |
| `durationMs` | number | Yes | Duration in milliseconds |

- **Success Response:**

```json
{ "success": true }
```

- **Error Response (HTTP 400):**

```json
{ "error": "Missing required fields" }
```

---

### GET `/api/dispatch/units`

Returns all dispatch units.

- **Auth:** Session required
- **Response:**

```json
{
  "units": [
    {
      "id": 1,
      "identity": "U-101",
      "channel": "North__Dispatch",
      "status": "available",
      "location": null,
      "is_emergency": false,
      "last_seen": "2026-04-10T12:00:00.000Z"
    }
  ]
}
```

---

### POST `/api/dispatch/unit/update`

Upsert (create or update) a unit's properties.

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `identity` | string | Yes | Unit identifier (e.g., `"U-101"`) |
| `channel` | string | No | Current channel |
| `status` | string | No | Unit status |
| `location` | object | No | Location data |
| `isEmergency` | boolean | No | Emergency state |

- **Success Response:**

```json
{
  "unit": { ... }
}
```

---

### POST `/api/dispatch/units/:id/emergency`

Toggle emergency state for a unit.

- **Auth:** Session required
- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | string | Unit ID |

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `active` | boolean | Yes | Whether emergency is active |

- **Success Response:**

```json
{
  "unit": { ... }
}
```

- **Error Response (HTTP 404):**

```json
{ "error": "Unit not found" }
```

---

### POST `/api/dispatch/emergency/ack`

Acknowledge an active emergency.

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `identity` | string | Yes | Unit identity |
| `channel` | string | Yes | Channel |
| `acknowledgedBy` | string | Yes | Who acknowledged |

- **Success Response:**

```json
{ "success": true }
```

---

### POST `/api/dispatch/emergency/reset`

Reset/clear an emergency. Only dispatchers or admins can reset.

- **Auth:** Session required (dispatcher or admin role)
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `identity` | string | Yes | Unit identity |
| `channel` | string | No | Channel |
| `confirmIdentity` | string | Yes | Must match `identity` (case-insensitive) |

- **Success Response:**

```json
{ "success": true }
```

- **Error Responses:**

| Status | Body |
|---|---|
| `403` | `{ "error": "Only dispatchers or admins can reset emergencies" }` |
| `400` | `{ "error": "Unit ID confirmation does not match" }` |

---

### GET `/api/dispatch/monitor/:dispatcherId`

Get the monitor set for a dispatcher.

- **Auth:** Session required
- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `dispatcherId` | string | Dispatcher ID |

- **Response:**

```json
{
  "monitor": {
    "primary": "...",
    "monitored": ["..."],
    "primaryTxChannelId": "..."
  }
}
```

---

### POST `/api/dispatch/monitor/:dispatcherId`

Set the monitor set for a dispatcher.

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `primary` | string | Yes | Primary channel |
| `monitored` | array | Yes | List of monitored channels |
| `primaryTxChannelId` | string | No | Primary TX channel ID |

- **Response:**

```json
{
  "monitor": { ... }
}
```

---

### GET `/api/dispatch/channels`

Get all radio channels.

- **Auth:** Session required
- **Response:**

```json
{
  "channels": [
    {
      "id": 1,
      "name": "Dispatch",
      "livekit_room_name": "...",
      "is_emergency_only": false,
      "is_active": true
    }
  ]
}
```

---

### POST `/api/dispatch/channels`

Create a new radio channel.

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Channel name |
| `livekit_room_name` | string | No | Room name |
| `is_emergency_only` | boolean | No | Emergency-only flag |
| `is_active` | boolean | No | Active flag |

- **Success Response (HTTP 201):**

```json
{
  "channel": { ... }
}
```

- **Error Response:**

```json
{ "error": "Channel name required" }
```

---

### PATCH `/api/dispatch/channels/:id`

Update a channel.

- **Auth:** Session required
- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | string | Channel ID |

- **Request Body:** Any channel fields to update.
- **Success Response:**

```json
{
  "channel": { ... }
}
```

- **Error Response (HTTP 404):**

```json
{ "error": "Channel not found" }
```

---

### GET `/api/dispatch/patches`

Get all channel patches.

- **Auth:** Session required
- **Response:**

```json
{
  "patches": [
    {
      "id": 1,
      "name": "Patch A",
      "source_channel_id": 1,
      "target_channel_id": 2,
      "is_enabled": true
    }
  ]
}
```

---

### POST `/api/dispatch/patches`

Create a channel patch.

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | Patch name |
| `source_channel_id` | integer | Yes | Source channel ID |
| `target_channel_id` | integer | Yes | Target channel ID |
| `is_enabled` | boolean | No | Enabled flag |

- **Success Response (HTTP 201):**

```json
{
  "patch": { ... }
}
```

- **Error Response:**

```json
{ "error": "Source and target channel IDs required" }
```

---

### PATCH `/api/dispatch/patches/:id`

Update a channel patch.

- **Auth:** Session required
- **Request Body:** Any patch fields to update.
- **Success Response:**

```json
{
  "patch": { ... }
}
```

---

### GET `/api/dispatch/events`

Get the last 100 radio events.

- **Auth:** Session required
- **Response:**

```json
{
  "events": [
    {
      "id": 1,
      "type": "ptt_start",
      "unit_id": "U-101",
      "channel": "North__Dispatch",
      "timestamp": "2026-04-10T12:00:00.000Z",
      "details": { ... }
    }
  ]
}
```

---

### POST `/api/dispatch/notify-join`

Notify that a unit has joined a channel (triggers AI dispatcher if configured).

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `channel` | string | Yes | Channel room key |
| `identity` | string | Yes | Unit identity |

- **Response:**

```json
{
  "triggered": true,
  "channel": "North__Dispatch",
  "message": "AI Dispatcher connected"
}
```

---

### POST `/api/dispatch/notify-ptt`

Notify of a PTT event (for AI dispatcher).

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `channel` | string | Yes | Channel room key |
| `identity` | string | No | Unit identity (falls back to session user) |
| `action` | string | Yes | `"start"` or `"end"` |

- **Response:**

```json
{
  "triggered": true,
  "channel": "North__Dispatch",
  "action": "start"
}
```

---

### POST `/api/dispatch/notify-emergency`

Notify of an emergency event (for AI dispatcher).

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `channel` | string | Yes | Channel room key |
| `identity` | string | Yes | Unit identity |
| `active` | boolean | Yes | Whether emergency is active |

- **Response:**

```json
{
  "triggered": true,
  "channel": "North__Dispatch",
  "message": "Emergency escalation started"
}
```

---

### GET `/api/dispatch/unit-locations`

Returns current GPS locations for all tracked units as an **array**.

- **Auth:** Session required
- **Response:**

```json
{
  "locations": [
    {
      "unitId": "U-101",
      "lat": 40.7128,
      "lng": -74.0060,
      "accuracy": 10,
      "heading": 180,
      "speed": 0,
      "timestamp": 1712764800000
    }
  ]
}
```

---

## PTT Endpoints

All endpoints are under `/api/ptt`.

### POST `/api/ptt/start`

Request to start a PTT transmission. The unit must either have live Socket.IO presence or a valid session with DB-verified channel access.

- **Auth:** Socket.IO presence **or** Session + DB channel access
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `channelId` | string | Yes | Channel ID (numeric ID or `zone__channelName` room key) |
| `unitId` | string | Yes | Unit ID of the transmitting unit |

- **Success Response:**

```json
{ "success": true }
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "channelId and unitId required" }` | Missing fields |
| `400` | `{ "error": "Invalid channelId or roomKey" }` | Channel not found |
| `403` | `{ "error": "Unit not authenticated" }` | No presence and no valid session |
| `403` | `{ "error": "Unit does not have access to this channel" }` | Session valid but no channel access |
| `409` | `{ "error": "Channel busy", "heldBy": "U-102", "reason": "..." }` | Another unit holds the floor |
| `503` | `{ "error": "Signaling not ready" }` | Socket.IO not initialized |

---

### POST `/api/ptt/end`

End a PTT transmission.

- **Auth:** Same as `/api/ptt/start`
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `channelId` | string | Yes | Channel ID (numeric ID or `zone__channelName` room key) |
| `unitId` | string | Yes | Unit ID of the transmitting unit |

- **Success Response:**

```json
{ "success": true }
```

---

### GET `/api/ptt/token`

**Deprecated.** Returns `410 Gone`.

```json
{ "error": "Audio Transport tokens are no longer issued. Audio uses WebSocket transport." }
```

---

## Channel Endpoints

### GET `/api/channels/`

Returns channels accessible to the authenticated user.

- **Auth:** Session required
- **Response:**

```json
{
  "channels": [
    {
      "id": 1,
      "name": "Dispatch",
      "zone": "North",
      "room_key": "North__Dispatch",
      "enabled": true
    }
  ]
}
```

---

## Location Endpoints

All endpoints are under `/api/location`. **No session auth is required** for any of these endpoints.

### POST `/api/location/`

Update a unit's GPS location.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `unitId` | string | Yes | Unit identifier |
| `lat` | number | Yes | Latitude |
| `lng` | number | Yes | Longitude |
| `accuracy` | number | No | GPS accuracy in meters |
| `channel` | string | No | Current channel |

- **Success Response:**

```json
{ "success": true }
```

- **Error Response (HTTP 400):**

```json
{ "error": "Missing required fields: unitId, lat, lng" }
```

---

### GET `/api/location/`

Get all current unit locations.

- **Response:**

```json
{
  "locations": {
    "U-101": { "lat": 40.7128, "lng": -74.0060, "accuracy": 10, "channel": "North__Dispatch", "timestamp": 1712764800000 }
  }
}
```

---

### GET `/api/location/stream`

Server-Sent Events (SSE) stream of real-time location updates.

- **Headers set by server:**
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`

- **SSE Event Format:**

```
data: {"unitId":"U-101","lat":40.7128,"lng":-74.0060,...}
```

The connection stays open; the server pushes location updates as they arrive.

---

### GET `/api/location/:unitId`

Get a specific unit's location.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `unitId` | string | Unit identifier |

- **Success Response:**

```json
{
  "location": { "lat": 40.7128, "lng": -74.0060, "accuracy": 10 }
}
```

- **Error Response (HTTP 404):**

```json
{ "error": "Unit not found or location expired" }
```

---

## Message Endpoints

All endpoints are under `/api/messages`. **No global auth middleware** is applied to most message endpoints. The `/export/audio` endpoint requires the dispatcher role.

### GET `/api/messages/:channel`

Get messages for a channel.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `channel` | string | Channel room key (e.g., `North__Dispatch`) |

- **Query Parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | 50 | Max messages to return |
| `offset` | integer | 0 | Pagination offset |

- **Success Response:**

```json
{
  "success": true,
  "messages": [
    {
      "id": 1,
      "channel": "North__Dispatch",
      "sender": "U-101",
      "type": "text",
      "content": "10-4",
      "created_at": "2026-04-10T12:00:00.000Z"
    }
  ]
}
```

---

### POST `/api/messages/:channel/text`

Send a text message to a channel.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `channel` | string | Channel room key |

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Message text (must not be empty) |

- **Success Response:**

```json
{
  "success": true,
  "message": { ... }
}
```

- **Error Response:**

```json
{ "success": false, "error": "Message content is required" }
```

---

### POST `/api/messages/:channel/audio`

Send an audio message to a channel.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `channel` | string | Channel room key |

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `audio` | string | Yes | Base64-encoded audio data |
| `sender` | string | No | Sender ID (falls back to session user) |
| `duration` | number | No | Duration in ms |

- **Success Response:**

```json
{
  "success": true,
  "message": { ... }
}
```

---

### GET `/api/messages/audio/:filename`

Retrieve a stored audio file.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `filename` | string | Audio filename (no path separators allowed) |

- **Response:** Binary audio data with `Content-Type: audio/wav`.
- **Error Response (HTTP 404):**

```json
{ "success": false, "error": "Audio file not found" }
```

---

### POST `/api/messages/transcribe/:messageId`

Transcribe an audio message.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `messageId` | integer | Message ID |

- **Success Response:**

```json
{
  "success": true,
  "message": { ... }
}
```

---

### GET `/api/messages/export/audio`

Export audio messages as a ZIP archive. **Requires dispatcher role.**

- **Auth:** Session required (dispatcher role)
- **Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `channel` | string | Yes | Channel room key |
| `from` | string | Yes | Start date (ISO format) |
| `to` | string | Yes | End date (ISO format) |

- **Response:** ZIP file containing audio files and a `manifest.json` with:

```json
[
  {
    "file": "audio_1234.wav",
    "sender": "U-101",
    "timestamp": "2026-04-10T12:00:00.000Z",
    "duration_ms": 5000,
    "transcription": "10-4 copy"
  }
]
```

---

## Unit Endpoints

All endpoints are under `/api/unit`. All require session authentication (`connect.sid` cookie) via the `requireAuth` middleware.

### POST `/api/unit/status`

Update the authenticated user's unit status. Also syncs the status to the external CAD system and updates the local database.

- **Auth:** Session required
- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | string | Yes | The new unit status (e.g., `"available"`, `"busy"`, `"off_duty"`) |

- **Success Response:**

```json
{
  "success": true,
  "status": "available",
  "cadResult": { ... }
}
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "success": false, "message": "Unit ID not found" }` | Session has no unit_id or username |
| `400` | `{ "success": false, "message": "Status is required" }` | Missing `status` field |

- **curl:**

```bash
curl -X POST https://<host>/api/unit/status \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"status":"available"}'
```

---

### GET `/api/unit/status`

Get the authenticated user's current unit status from the local database.

- **Auth:** Session required
- **Success Response:**

```json
{
  "success": true,
  "status": "available"
}
```

- **Error Response (HTTP 400):**

```json
{ "success": false, "message": "Unit ID not found" }
```

- **curl:**

```bash
curl https://<host>/api/unit/status \
  -b cookies.txt
```

---

### GET `/api/unit/contacts`

Returns a list of all non-blocked users with a unit ID, suitable for building contact lists.

- **Auth:** Session required
- **Success Response:**

```json
{
  "success": true,
  "contacts": [
    {
      "id": 1,
      "name": "U-101",
      "role": "user",
      "status": "available"
    }
  ]
}
```

- **curl:**

```bash
curl https://<host>/api/unit/contacts \
  -b cookies.txt
```

---

## Radio Config Endpoints

All endpoints are under `/api/radio`. All require session authentication (`connect.sid` cookie) via the `requireAuth` middleware.

### GET `/api/radio/config`

Returns the radio transport configuration needed for clients to connect to the audio system.

- **Auth:** Session required
- **Success Response:**

```json
{
  "transportMode": "custom-radio",
  "signalingUrl": "https://your-radio-server.replit.app",
  "audioRelayHost": "your-radio-server.replit.app",
  "audioRelayPort": 5100,
  "useTls": true
}
```

| Field | Type | Description |
|---|---|---|
| `transportMode` | string | Radio transport mode (default: `"custom-radio"`, from `RADIO_TRANSPORT_MODE` env var) |
| `signalingUrl` | string | Full URL for Socket.IO signaling (auto-detected or from `RADIO_SIGNALING_URL` env var) |
| `audioRelayHost` | string | Hostname for the audio relay (from `AUDIO_RELAY_HOST` env var or request hostname) |
| `audioRelayPort` | number | Port for the audio relay (from `AUDIO_RELAY_PORT` env var, default: `5100`) |
| `useTls` | boolean | Whether TLS is enabled (auto-detected from protocol or `RADIO_USE_TLS` env var) |

- **curl:**

```bash
curl https://<host>/api/radio/config \
  -b cookies.txt
```

---

## Recording Log Endpoints

All endpoints are under `/api/recording-logs`. All require session authentication with the **dispatcher role** via the `requireDispatcher` middleware.

### GET `/api/recording-logs/filters`

Returns the available filter options (distinct units and channels) for the recording log search.

- **Auth:** Session required (dispatcher role)
- **Success Response:**

```json
{
  "success": true,
  "units": ["U-101", "U-102", "DISPATCH"],
  "channels": ["North__Dispatch", "South__Patrol"]
}
```

- **curl:**

```bash
curl https://<host>/api/recording-logs/filters \
  -b cookies.txt
```

---

### GET `/api/recording-logs/search`

Search and paginate through audio transmission logs.

- **Auth:** Session required (dispatcher role)
- **Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `channels` | string | No | Comma-separated list of channel room keys to filter by |
| `units` | string | No | Comma-separated list of unit IDs to filter by |
| `from` | string | No | Start date (ISO format) |
| `to` | string | No | End date (ISO format) |
| `limit` | integer | No | Max results (default: `100`, max: `500`) |
| `offset` | integer | No | Pagination offset (default: `0`) |

- **Success Response:**

```json
{
  "success": true,
  "logs": [
    {
      "id": 1,
      "sender": "U-101",
      "channel": "North__Dispatch",
      "audio_url": "/api/messages/audio/audio_1234.wav",
      "audio_duration": 5000,
      "transcription": "10-4 copy",
      "created_at": "2026-04-10T12:00:00.000Z",
      "audio_available": true
    }
  ],
  "total": 150
}
```

- **Error Response (HTTP 400):**

```json
{ "success": false, "error": "Invalid date format" }
```

- **curl:**

```bash
curl "https://<host>/api/recording-logs/search?channels=North__Dispatch&from=2026-04-01&to=2026-04-11&limit=50" \
  -b cookies.txt
```

---

### GET `/api/recording-logs/export/pdf`

Export a transmission log as a PDF document.

- **Auth:** Session required (dispatcher role)
- **Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `channels` | string | No | Comma-separated list of channel room keys |
| `units` | string | No | Comma-separated list of unit IDs |
| `from` | string | No | Start date (ISO format) |
| `to` | string | No | End date (ISO format) |
| `tz` | integer | No | Timezone offset in minutes (for display formatting) |

- **Response:** PDF file (`Content-Type: application/pdf`) containing a tabular transmission log with date, time, unit, channel, and duration columns.

- **curl:**

```bash
curl "https://<host>/api/recording-logs/export/pdf?channels=North__Dispatch&from=2026-04-01&to=2026-04-11&tz=-300" \
  -b cookies.txt \
  -o transmission_log.pdf
```

---

### GET `/api/recording-logs/export/zip`

Export audio recordings and a PDF log as a ZIP archive.

- **Auth:** Session required (dispatcher role)
- **Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `channels` | string | No | Comma-separated list of channel room keys |
| `units` | string | No | Comma-separated list of unit IDs |
| `from` | string | No | Start date (ISO format) |
| `to` | string | No | End date (ISO format) |
| `tz` | integer | No | Timezone offset in minutes (for display formatting) |

- **Response:** ZIP file (`Content-Type: application/zip`) containing:
  - A PDF transmission log
  - Individual `.wav` audio files named by date and time

- **Error Response (HTTP 404):**

```json
{ "success": false, "error": "No audio messages found" }
```

- **curl:**

```bash
curl "https://<host>/api/recording-logs/export/zip?channels=North__Dispatch&from=2026-04-01&to=2026-04-11&tz=-300" \
  -b cookies.txt \
  -o recordings.zip
```

---

## Admin Endpoints

> **Note:** These are internal administration endpoints. All endpoints are under `/api/admin` and require session authentication with the **admin role** via the `requireAdmin` middleware. These endpoints use the `success(res, data)` helper which sends data directly. Resource creation endpoints return HTTP `201`.

### User Management

#### GET `/api/admin/users`

List all users.

- **Success Response:**

```json
{
  "users": [
    {
      "id": 1,
      "username": "officer1",
      "email": "officer1@dept.gov",
      "role": "user",
      "unit_id": "U-101",
      "is_dispatcher": false,
      "status": "active"
    }
  ]
}
```

---

#### POST `/api/admin/users`

Create a new user.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | string | Yes | Username |
| `password` | string | Yes | Password |
| `role` | string | No | Role (default: `"user"`) |
| `email` | string | No | Email address |
| `unit_id` | string | No | Unit identifier |
| `channelIds` | array | No | Array of channel IDs to grant access to |
| `is_dispatcher` | boolean | No | Whether user is a dispatcher (default: `false`) |

- **Success Response (HTTP 201):**

```json
{
  "user": { ... }
}
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "Username and password required" }` | Missing required fields |
| `400` | `{ "error": "Username already exists" }` | Duplicate username |

---

#### PUT `/api/admin/users/:id`

Update a user.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | User ID |

- **Request Body:** Any user fields to update (e.g., `role`, `email`, `unit_id`, `is_dispatcher`).

- **Success Response:**

```json
{
  "user": { ... }
}
```

- **Error Response (HTTP 404):**

```json
{ "error": "User not found" }
```

---

#### DELETE `/api/admin/users/:id`

Delete a user.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | User ID |

- **Success Response:**

```json
{ "success": true }
```

- **Error Response (HTTP 404):**

```json
{ "error": "User not found" }
```

---

#### PUT `/api/admin/users/:id/password`

Reset a user's password.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | User ID |

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `password` | string | Yes | New password |

- **Success Response:**

```json
{ "success": true }
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "Password required" }` | Missing password |
| `404` | `{ "error": "User not found" }` | User not found |

---

#### GET `/api/admin/users/:id/channels`

Get the channel IDs a user has access to.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | User ID |

- **Success Response:**

```json
{
  "channelIds": [1, 2, 3]
}
```

---

#### PUT `/api/admin/users/:id/channels`

Set the channels a user has access to (replaces all existing access).

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | User ID |

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `channelIds` | array | No | Array of channel IDs (default: `[]`) |

- **Success Response:**

```json
{ "success": true }
```

---

### Channel Management

#### GET `/api/admin/channels`

List all channels.

- **Success Response:**

```json
{
  "channels": [ ... ]
}
```

---

#### POST `/api/admin/channels`

Create a new channel.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Channel name |
| `zone` | string | Yes | Zone name |
| `zone_id` | integer | No | Zone ID (alternative: `zoneId`) |

- **Success Response (HTTP 201):**

```json
{
  "channel": { ... }
}
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "Name and zone required" }` | Missing required fields |
| `400` | `{ "error": "Channel name already exists in this zone" }` | Duplicate channel |

---

#### PUT `/api/admin/channels/:id`

Update a channel.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | Channel ID |

- **Request Body:** Any channel fields to update.

- **Success Response:**

```json
{
  "channel": { ... }
}
```

- **Error Response (HTTP 404):**

```json
{ "error": "Channel not found" }
```

---

#### DELETE `/api/admin/channels/:id`

Delete a channel.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | Channel ID |

- **Success Response:**

```json
{ "success": true }
```

- **Error Response (HTTP 404):**

```json
{ "error": "Channel not found" }
```

---

### Zone Management

#### GET `/api/admin/zones`

List all zones.

- **Success Response:**

```json
{
  "zones": [ ... ]
}
```

---

#### POST `/api/admin/zones`

Create a new zone.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Zone name |

- **Success Response (HTTP 201):**

```json
{
  "zone": { ... }
}
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "Zone name required" }` | Missing name |
| `400` | `{ "error": "Zone name already exists" }` | Duplicate zone |

---

#### PUT `/api/admin/zones/:id`

Update a zone.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | Zone ID |

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | New zone name |

- **Success Response:**

```json
{
  "zone": { ... }
}
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "Zone name required" }` | Missing name |
| `404` | `{ "error": "Zone not found" }` | Zone not found |

---

#### DELETE `/api/admin/zones/:id`

Delete a zone.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | integer | Zone ID |

- **Success Response:**

```json
{ "success": true }
```

- **Error Response (HTTP 404):**

```json
{ "error": "Zone not found" }
```

---

### AI Dispatch

#### GET `/api/admin/ai-dispatch`

Get AI dispatch configuration.

- **Success Response:**

```json
{
  "enabled": true,
  "channel": "North__Dispatch"
}
```

---

#### PUT `/api/admin/ai-dispatch`

Enable or disable the AI dispatcher.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | Yes | Whether to enable AI dispatch |
| `channel` | string | No | Dispatch channel room key (required if enabling and not previously set) |

- **Success Response:**

```json
{
  "enabled": true,
  "channel": "North__Dispatch"
}
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "enabled must be a boolean" }` | Invalid type |
| `400` | `{ "error": "Dispatch channel is required to enable AI" }` | No channel specified |

---

### Audio Tuning

#### GET `/api/admin/audio-tuning`

Get the current DSP audio tuning configuration and defaults.

- **Success Response:**

```json
{
  "config": {
    "txHpAlpha": 0.9889,
    "txCompThresholdDb": -18.0,
    "txGain": 1.4,
    "rxGain": 2.5,
    "opusBitrate": 48000
  },
  "defaults": {
    "txHpAlpha": 0.9889,
    "txCompThresholdDb": -18.0,
    "txGain": 1.4,
    "rxGain": 2.5,
    "opusBitrate": 48000
  }
}
```

---

#### PUT `/api/admin/audio-tuning`

Update DSP audio tuning parameters. Updated config is broadcast to all connected clients via the `radio:dsp_config` Socket.IO event.

- **Request Body:** An object with DSP parameter keys and numeric values. Only recognized keys from the defaults are applied.

- **Success Response:**

```json
{
  "config": { ... }
}
```

- **Error Response (HTTP 400):**

```json
{ "error": "Invalid config object" }
```

---

#### POST `/api/admin/audio-tuning/reset`

Reset all DSP audio tuning parameters to defaults and broadcast to all connected clients.

- **Success Response:**

```json
{
  "config": { ... }
}
```

---

### Scanner Feed

#### GET `/api/admin/scanner`

Get the current scanner feed status.

- **Success Response:**

```json
{
  "enabled": false,
  "streamUrl": null,
  "channelName": null
}
```

---

#### POST `/api/admin/scanner`

Enable or disable the scanner feed.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | Yes | Whether to enable the scanner feed |
| `streamUrl` | string | Yes* | HTTP/HTTPS stream URL (*required if enabling) |
| `channelName` | string | Yes* | Target channel name or room key (*required if enabling) |

- **Success Response:**

```json
{
  "enabled": true,
  "streamUrl": "https://stream.example.com/feed",
  "channelName": "North__Dispatch"
}
```

- **Error Responses:**

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "enabled must be a boolean" }` | Invalid type |
| `400` | `{ "error": "streamUrl and channelName are required to enable scanner" }` | Missing fields |
| `400` | `{ "error": "Stream URL must use http or https protocol" }` | Invalid protocol |
| `400` | `{ "error": "Invalid stream URL" }` | Malformed URL |
| `400` | `{ "error": "Channel not found or not enabled" }` | Channel doesn't exist |

---

### Activity Logs

#### GET `/api/admin/logs`

Get the last 100 admin activity log entries.

- **Success Response:**

```json
{
  "logs": [
    {
      "id": 1,
      "user_id": 1,
      "username": "admin",
      "action": "admin_create_user",
      "details": { "newUser": "officer2" },
      "created_at": "2026-04-10T12:00:00.000Z"
    }
  ]
}
```

---

### VM Logs

#### GET `/api/admin/vm-logs`

Stream server or system logs as Server-Sent Events (SSE).

- **Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `source` | string | No | `"server"` (default, pm2 logs) or `"system"` (journalctl) |

- **Headers set by server:**
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`

- **SSE Event Format:**

```
data: {"line":"[info] Server started on port 3000","source":"server","ts":1712764800000}
```

The connection stays open; the server pushes log lines as they are produced. The server sends `": ping\n\n"` heartbeats every 20 seconds.

---

## Internal CAD Proxy Endpoints

All endpoints are under `/api/cad`. All require session authentication (`connect.sid` cookie) via the `requireAuth` middleware. These endpoints proxy requests to an external CAD system configured via `CAD_URL` and `CAD_API_KEY` environment variables.

**Response pattern:** On success, the external CAD system's JSON response is passed through directly (via `res.json(result)`). On failure, the server returns:

```json
{ "success": false, "message": "Error description" }
```

If the external CAD is unreachable, some endpoints return hardcoded fallback data (noted below).

### POST `/api/cad/query/person`

Query a person record.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `firstName` | string | Yes* | First name (*at least one of firstName/lastName required) |
| `lastName` | string | Yes* | Last name |
| `dob` | string | No | Date of birth |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "results": [
    {
      "first_name": "JOHN",
      "last_name": "DOE",
      "dob": "1990-01-15",
      "dl_number": "12345678",
      "dl_state": "PA"
    }
  ]
}
```

- **Error Response (HTTP 400):**

```json
{ "success": false, "message": "First name or last name is required" }
```

---

### POST `/api/cad/query/vehicle`

Query a vehicle record.

> **Note:** The `vin` field is accepted for validation purposes but the current implementation only forwards `plate` and `state` to the external CAD. VIN-based lookup may not return results until forwarding is implemented.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `plate` | string | Yes* | License plate (*at least one of plate/vin required for validation) |
| `state` | string | No | State code (default: `"PA"`) |
| `vin` | string | Yes* | Vehicle identification number (*accepted but not yet forwarded to CAD — see note above) |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "results": [
    {
      "plate": "ABC1234",
      "state": "PA",
      "vin": "1HGBH41JXMN109186",
      "make": "HONDA",
      "model": "CIVIC",
      "year": "2021",
      "color": "BLACK"
    }
  ]
}
```

- **Error Response (HTTP 400):**

```json
{ "success": false, "message": "Plate or VIN is required" }
```

---

### POST `/api/cad/query/warrant`

Query warrants for a person.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `firstName` | string | Yes | First name |
| `lastName` | string | Yes | Last name |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "results": [
    {
      "first_name": "JOHN",
      "last_name": "DOE",
      "warrant_type": "BENCH",
      "case_number": "CR-2025-1234",
      "issued_date": "2025-06-01"
    }
  ]
}
```

- **Error Response (HTTP 400):**

```json
{ "success": false, "message": "First and last name are required" }
```

---

### GET `/api/cad/calls`

Get active calls.

- **Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by call status |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "calls": [
    {
      "call_number": "2026-04100001",
      "nature": "DISTURBANCE",
      "location": "123 MAIN ST",
      "status": "dispatched",
      "units": ["U-101"],
      "priority": 2,
      "created_at": "2026-04-10T12:00:00.000Z"
    }
  ]
}
```

---

### GET `/api/cad/call/:callId`

Get details for a specific call.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `callId` | string | Call identifier |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "call": {
    "call_number": "2026-04100001",
    "nature": "DISTURBANCE",
    "location": "123 MAIN ST",
    "status": "dispatched",
    "units": ["U-101"],
    "priority": 2,
    "notes": [],
    "created_at": "2026-04-10T12:00:00.000Z"
  }
}
```

---

### GET `/api/cad/status-check`

Get current status check information from the external CAD.

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "status_check": { ... }
}
```

---

### POST `/api/cad/unit/:unitId/status/cycle`

Cycle a unit's status to the next state.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `unitId` | string | Unit identifier |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "unit": {
    "unit_id": "U-101",
    "status": "en_route"
  }
}
```

---

### POST `/api/cad/broadcast`

Send a broadcast message.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | Yes | Broadcast message text |
| `priority` | string | No | Priority level (default: `"routine"`) |

- **Success Response (proxied from external CAD):**

```json
{ "success": true }
```

- **Error Response (HTTP 400):**

```json
{ "success": false, "message": "Message is required" }
```

---

### GET `/api/cad/animal/types`

Get available animal types.

- **Response (fallback if CAD unavailable):**

```json
{
  "types": ["Dog", "Cat", "Horse", "Bird", "Livestock", "Wildlife", "Other"]
}
```

---

### POST `/api/cad/animal/search`

Search for animal records.

- **Request Body:** Search criteria object (passed to the external CAD).
- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "results": [ ... ]
}
```

---

### POST `/api/cad/citation/new`

Create a new citation.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | Citation type |
| `populateFrom` | object | No | Data to populate the citation from |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "citation": { ... }
}
```

---

### GET `/api/cad/map/redirect`

Redirects to the configured map URL.

- **Response:** HTTP 302 redirect to the map URL, or `404` if not configured.

---

### GET `/api/cad/unit/current-call`

Get the current call assigned to the authenticated user's unit.

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "call_number": "2026-04100001",
  "nature": "DISTURBANCE",
  "location": "123 MAIN ST"
}
```

- **Fallback Response (no unit ID or CAD error):**

```json
{ "callNumber": null }
```

---

### POST `/api/cad/fi/create`

Create a field interview record.

- **Request Body:** Field interview data object (passed to the external CAD).
- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "fi": { ... }
}
```

---

### GET `/api/cad/fleet/units`

Get fleet unit list for the authenticated user.

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "units": [ ... ]
}
```

---

### POST `/api/cad/fleet/unit/:unitId/status`

Update a fleet unit's status.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `unitId` | string | Unit identifier |

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | string | Yes | New status |

- **Success Response (proxied from external CAD):**

```json
{ "success": true }
```

---

### POST `/api/cad/fleet/unit/:unitId/fuel`

Add a fuel entry for a fleet unit.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `unitId` | string | Unit identifier |

- **Request Body:** Fuel entry data (passed to the external CAD).
- **Success Response (proxied from external CAD):**

```json
{ "success": true }
```

---

### GET `/api/cad/bolo/recent`

Get recent BOLOs (Be On the Lookout).

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "bolos": [ ... ]
}
```

---

### GET `/api/cad/contacts`

Get contact list for the authenticated user.

- **Response (fallback):**

```json
{ "contacts": [] }
```

---

### GET `/api/cad/chats`

Get chat threads for the authenticated user.

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "chats": [ ... ]
}
```

---

### POST `/api/cad/chats`

Create a new chat thread.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `recipientId` | string | Yes | Recipient user ID |
| `message` | string | Yes | Initial message |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "chat": { ... }
}
```

---

### DELETE `/api/cad/chats/:chatId`

Delete a chat thread.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `chatId` | string | Chat thread ID |

- **Success Response (proxied from external CAD):**

```json
{ "success": true }
```

---

### GET `/api/cad/chats/:chatId/messages`

Get messages in a chat thread.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `chatId` | string | Chat thread ID |

- **Success Response (proxied from external CAD):**

```json
{
  "success": true,
  "messages": [ ... ]
}
```

---

### POST `/api/cad/chats/:chatId/messages`

Send a message in a chat thread.

- **Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `chatId` | string | Chat thread ID |

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | Yes | Message text |

- **Success Response (proxied from external CAD):**

```json
{ "success": true }
```

---

### GET `/api/cad/messages/unread`

Get unread message count for the authenticated user.

- **Response (fallback):**

```json
{ "count": 0 }
```

---

### GET `/api/cad/pending-checks`

Get pending status checks.

- **Response (fallback):**

```json
{ "checks": [] }
```

---

### POST `/api/cad/respond-check`

Respond to a status check.

- **Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `unitId` | string | Yes | Unit identifier |
| `status` | string | Yes | Response status |

- **Success Response (proxied from external CAD):**

```json
{ "success": true }
```

---

### GET `/api/cad/system/config`

Get system configuration (dropdown options, etc.).

- **Response (fallback):**

```json
{
  "counties": [],
  "sexOptions": ["Male", "Female", "Unknown"],
  "raceOptions": ["White", "Black", "Hispanic", "Asian", "Native American", "Pacific Islander", "Other", "Unknown"],
  "eyeColors": ["Brown", "Blue", "Green", "Hazel", "Gray", "Black", "Unknown"],
  "hairColors": ["Black", "Brown", "Blonde", "Red", "Gray", "White", "Bald", "Unknown"],
  "vehicleTypes": ["Sedan", "SUV", "Truck", "Van", "Motorcycle", "Other"],
  "vehicleStyles": ["2-Door", "4-Door", "Hatchback", "Convertible", "Pickup", "Other"],
  "vehicleColors": ["Black", "White", "Silver", "Gray", "Red", "Blue", "Green", "Brown", "Tan", "Gold", "Orange", "Yellow", "Purple", "Other"]
}
```

---

## Socket.IO Signaling

### Connection

| Setting | Value |
|---|---|
| **URL** | `https://<host>` |
| **Path** | `/signaling` |
| **Transports** | `websocket`, `polling` |
| **Credentials** | `withCredentials: true` (sends `connect.sid` cookie) |
| **Ping Interval** | 25,000 ms |
| **Ping Timeout** | 60,000 ms |

```javascript
const socket = io('https://<host>', {
  path: '/signaling',
  withCredentials: true,
  transports: ['websocket', 'polling'],
});
```

### Authentication Flow

1. Connect to the server.
2. On `connect`, emit the `authenticate` event:

```javascript
socket.emit('authenticate', {
  unitId: 'U-101',
  username: 'officer1',
  agencyId: 'default',
  isDispatcher: false,
});
```

3. The server validates against the session cookie if present, then emits:

```javascript
socket.on('authenticated', (data) => {
  // data: { unitId, timestamp, voiceAvailable }
});

socket.on('auth:error', (data) => {
  // data: { message }
});
```

### Inbound Events (Client → Server)

| Event | Payload | Description |
|---|---|---|
| `authenticate` | `{ unitId, username, agencyId, isDispatcher }` | Authenticate the socket connection |
| `channel:join` | `{ channelId }` | Join a radio channel room |
| `channel:leave` | `{ channelId }` | Leave a radio channel room |
| `ptt:start` | `{ channelId }` | Request PTT floor on a channel |
| `ptt:end` | `{ channelId }` | Release PTT floor |
| `ptt:pre` | `{ channelId }` | Pre-PTT signal (notify others you're about to transmit) |
| `emergency:start` | `{ channelId }` | Declare emergency on a channel |
| `emergency:end` | `{ channelId, acknowledgedBy? }` | End emergency (unit or dispatcher) |
| `clear_air:start` | `{ channelId }` | Start clear-air mode (dispatcher only) |
| `clear_air:end` | `{ channelId }` | End clear-air mode (dispatcher only) |
| `unit:status` | `{ status }` | Update unit status |
| `unit:location` | `{ latitude, longitude, accuracy, heading, speed }` | Update unit GPS location |
| `token:request` | `{ requestId, channelId }` | Request an audio transport token |
| `data:send` | `{ channelId, payload }` | Send data to other units on the channel |
| `location:track_start` | `{ unitId }` | Start GPS tracking for a unit (dispatcher only) |
| `location:track_stop` | `{ unitId }` | Stop GPS tracking for a unit (dispatcher only) |
| `location:update` | `{ lat, lng, accuracy, heading, speed, timestamp }` | Push GPS update from the unit |
| `radio:joinChannel` | `{ channelId, udpPort?, udpAddress? }` | Join channel (radio client protocol, DB-verified) |
| `radio:leaveChannel` | `{ channelId }` | Leave channel (radio client protocol) |
| `ptt:request` | `{ channelId }` | Request PTT (radio client protocol) |
| `ptt:release` | `{ channelId }` | Release PTT (radio client protocol) |
| `tx:start` | `{ channelId }` | Confirm transmission start (radio client protocol, requires floor grant) |
| `tx:stop` | `{ channelId }` | Stop transmission (radio client protocol) |
| `ping` | _(none)_ | Keep-alive ping (server replies with `pong`) |

### Outbound Events (Server → Client)

| Event | Payload | Description |
|---|---|---|
| `authenticated` | `{ unitId, timestamp, voiceAvailable }` | Authentication success |
| `auth:error` | `{ message }` | Authentication failure |
| `error` | `{ message }` | General error (e.g., "Not authenticated", "Not authorized for this channel", "Cannot start TX without floor grant") |
| `channel:join` | `{ unitId, agencyId, channelId, timestamp, isDispatcher }` | A unit joined the channel |
| `channel:leave` | `{ unitId, agencyId, channelId, timestamp, reason? }` | A unit left the channel. `reason` may be `"disconnect"`. |
| `channel:members` | `{ channelId, members }` | Current channel member list (sent on join). `members` is `[{ unitId, username, status, isDispatcher }]`. |
| `ptt:start` | `{ unitId, agencyId, channelId, timestamp, isEmergency }` | PTT transmission started |
| `ptt:end` | `{ unitId, agencyId?, channelId, timestamp, duration?, gracePeriodMs?, reason? }` | PTT transmission ended. `reason` may be `"timeout"`, `"consistency_sweep"`, `"unitId_mismatch_cleanup"`, or `"disconnect"`. |
| `ptt:granted` | `{ channelId, unitId, timestamp }` | PTT floor granted to you (standard protocol) |
| `ptt:ready` | `{ channelId, unitId, timestamp }` | PTT ready signal (floor available after end) |
| `ptt:busy` | `{ channelId, transmittingUnit, inGracePeriod? }` | PTT denied — channel is busy (standard protocol) |
| `ptt:pre` | `{ unitId, channelId }` | Pre-PTT notification from another unit |
| `ptt:granted` (radio) | `{ channelId, senderUnitId, timestamp }` | PTT floor granted (radio client protocol) |
| `ptt:denied` | `{ channelId, reason, heldBy?, senderUnitId?, timestamp }` | PTT denied (radio protocol). Reasons: `"not_on_channel"`, `"preempted_emergency"`, `"floor_request_failed"`, or from `floorControlService`. |
| `emergency:start` | `{ unitId, agencyId, channelId, timestamp }` | Emergency declared on channel (sent to channel dispatchers) |
| `emergency:end` | `{ unitId, agencyId, channelId, timestamp, clearedBy, duration }` | Emergency ended (sent to channel dispatchers) |
| `emergency:force_connect` | `{ channelId, unitId, agencyId, timestamp, bypassGracePeriod, priority }` | Force-connect signal for emergency (sent to channel dispatchers) |
| `emergency:alert` | `{ unitId, agencyId, channelId, timestamp, message }` | Emergency alert broadcast to all dispatchers |
| `emergency:cleared` | `{ unitId, agencyId, channelId, timestamp, clearedBy, duration }` | Emergency cleared broadcast to all dispatchers |
| `clear_air:start` | `{ channelId, channelName, dispatcherId, agencyId, timestamp }` | Clear-air mode started (sent to channel dispatchers) |
| `clear_air:end` | `{ channelId, dispatcherId, agencyId, timestamp, duration }` | Clear-air mode ended (sent to channel dispatchers) |
| `clear_air:alert` | `{ channelId, channelName, dispatcherId, agencyId, timestamp, message }` | Clear-air alert broadcast to all dispatchers / sent to newly authenticated units |
| `clear_air:cleared` | `{ channelId, dispatcherId, agencyId, timestamp, duration }` | Clear-air cleared broadcast to all dispatchers |
| `unit:status` | `{ unitId, agencyId, channelId, status, timestamp }` | Unit status changed (broadcast to each channel the unit is on) |
| `unit:location` | `{ unitId, agencyId, channelId, latitude, longitude, accuracy, heading, speed, timestamp }` | Unit location update (sent to channel dispatchers) |
| `unit:connection_warning` | `{ unitId, channelId, status, timestamp }` | Unit may be disconnected. `status` is `"potentially_disconnected"`. |
| `location:update` | `{ unitId, lat, lng, accuracy, heading, speed, timestamp }` | GPS location pushed to all dispatchers |
| `location:track_start` | `{ requestedBy }` | Notification to a unit that GPS tracking was started. `requestedBy` is the dispatcher unitId or `"emergency"`. |
| `location:track_stop` | `{ requestedBy }` | Notification to a unit that GPS tracking was stopped. `requestedBy` is the dispatcher unitId or `"emergency_ack"`. |
| `token:response` | `{ requestId, shouldFetch, channelId }` | Audio transport token response |
| `data:message` | `{ channelId, payload, from, timestamp }` | Data message received from another unit |
| `radio:channelJoined` | `{ channelId, timestamp, members }` | Channel joined confirmation (radio protocol). `members` is `[{ unitId, username, status, isDispatcher }]`. |
| `radio:channelLeft` | `{ channelId, timestamp }` | Channel left confirmation (radio protocol) |
| `channel:busy` | `{ channelId, heldBy, timestamp }` | Channel is busy (radio protocol, sent on join if floor is held) |
| `channel:idle` | `{ channelId, timestamp }` | Channel became idle (radio protocol) |
| `tx:start` | `{ senderUnitId, channelId, timestamp, isEmergency }` | Transmission started (radio protocol) |
| `tx:stop` | `{ senderUnitId, channelId, timestamp, reason? }` | Transmission stopped (radio protocol). `reason` may be `"timeout"`, `"leave"`, or `"disconnect"`. |
| `tx:silence_warning` | `{ channelId, unitId, silenceMs, timestamp }` | Warning that a transmitting unit has been silent for an extended period |
| `radio:dsp_config` | `{ txHpAlpha, txGain, rxGain, opusBitrate, ... }` | DSP audio tuning configuration broadcast (sent when admin updates audio tuning) |
| `pong` | _(none)_ | Response to client `ping` |

---

## Audio WebSocket

### Connection

| Setting | Value |
|---|---|
| **URL** | `wss://<host>/api/audio-ws?channelId=<channelId>&unitId=<unitId>` |
| **Auth** | `connect.sid` session cookie (validated server-side) |
| **Protocol** | Native WebSocket (not Socket.IO) |

```javascript
const ws = new WebSocket(
  'wss://<host>/api/audio-ws?channelId=North__Dispatch&unitId=U-101'
);
ws.binaryType = 'arraybuffer';
```

The `channelId` query parameter uses the `zone__channelName` room key format. The `unitId` is informational; the server determines the actual unit identity from the session.

### Binary Packet Format (Preferred)

All audio is sent and received as binary WebSocket frames. The first byte is a **codec marker** that determines the payload format:

| Marker | Codec | Payload | Notes |
|--------|-------|---------|-------|
| `0x02` | **Opus** (preferred) | Raw Opus-encoded bytes (~100–200 bytes/frame) | End-to-end passthrough, best quality and lowest bandwidth |
| `0x01` | PCM (legacy) | int16[] little-endian samples (~1,920 bytes/frame) | Supported for backward compatibility |

The header layout is identical for both markers — only the payload interpretation differs:

```
Offset  Size         Field             Encoding
──────  ───────────  ────────────────  ─────────────────
0       1 byte       marker            0x02 (Opus) or 0x01 (PCM)
1       4 bytes      sequence          uint32, little-endian
5       1 byte       channelIdLen      uint8
6       N bytes      channelId         UTF-8 string (N = channelIdLen)
6+N     1 byte       senderIdLen       uint8
7+N     M bytes      senderId          UTF-8 string (M = senderIdLen)
7+N+M   remainder    payload           Opus bytes (0x02) or PCM int16[] (0x01)
```

**Diagram (Opus — marker `0x02`):**

```
┌────────┬──────────┬───────────┬───────────┬───────────┬──────────┬──────────────┐
│ 0x02   │ seq(u32) │ chLen(u8) │ channelId │ snLen(u8) │ senderId │ Opus bytes   │
│ 1 byte │ 4 bytes  │ 1 byte    │ N bytes   │ 1 byte    │ M bytes  │ remainder    │
└────────┴──────────┴───────────┴───────────┴───────────┴──────────┴──────────────┘
```

**Diagram (PCM legacy — marker `0x01`):**

```
┌────────┬──────────┬───────────┬───────────┬───────────┬──────────┬─────────────┐
│ 0x01   │ seq(u32) │ chLen(u8) │ channelId │ snLen(u8) │ senderId │ PCM int16[] │
│ 1 byte │ 4 bytes  │ 1 byte    │ N bytes   │ 1 byte    │ M bytes  │ remainder   │
└────────┴──────────┴───────────┴───────────┴───────────┴──────────┴─────────────┘
```

**RX (receiving audio):** The server sends **Opus frames (`0x02`)** by default. Clients must decode Opus to PCM for playback (e.g., using the `opus-decoder` WASM package or equivalent). Clients should also handle legacy `0x01` PCM frames for backward compatibility.

**TX (transmitting audio):** Clients may send either `0x02` (Opus) or `0x01` (PCM) frames. Opus is strongly preferred — it avoids a server-side re-encode step and preserves audio fidelity end-to-end. If sending PCM (`0x01`), the server will encode to Opus before relaying.

### JSON Fallback Format

If binary mode is unavailable, audio can be sent as JSON:

```json
{
  "type": "audio",
  "codec": "pcm",
  "sampleRate": 16000,
  "channels": 1,
  "frameSamples": 320,
  "sequence": 42,
  "channelId": "North__Dispatch",
  "payload": [0, 128, -256, ...]
}
```

The `payload` array must contain exactly 320 `int16` sample values. All six fields (`type`, `codec`, `sampleRate`, `channels`, `frameSamples`, `payload`) are validated and must match exactly.

### Heartbeat / Keep-alive Protocol

The server sends heartbeats at 30-second intervals:

| Direction | Message | Description |
|---|---|---|
| Server → Client | `{"type":"heartbeat","ts":1712764800000}` | Server heartbeat (JSON) |
| Server → Client | WebSocket ping frame | Protocol-level ping |
| Client → Server | `{"type":"pong","ts":1712764800000}` | JSON pong response |
| Client → Server | WebSocket pong frame | Protocol-level pong (automatic) |

**Timeout rules:**
- If a pong is not received within **10 seconds**, a missed-pong is counted.
- After **3 consecutive missed pongs**, the server terminates the connection.
- Ping interval: **30 seconds**.
- Pong check interval: **5 seconds**.

### Audio Specification

| Parameter | Value |
|---|---|
| **Sample Rate** | 16,000 Hz |
| **Channels** | 1 (mono) |
| **Sample Format** | int16 (signed 16-bit, little-endian) |
| **Frame Size** | 320 samples |
| **Frame Duration** | 20 ms (320 / 16000) |
| **Codec (RX wire)** | Opus passthrough (`0x02` marker); ~100–200 bytes/frame |
| **Codec (TX wire)** | Opus (`0x02`, preferred) or PCM (`0x01`, legacy fallback) |
| **Opus Encoding** | VOIP application, 16 kHz, mono, 320 samples/frame |

---

## Embeddable Radio Client

The radio server provides an embeddable JavaScript client for integrating PTT radio functionality directly into a CAD web page.

### Loading the Script

```html
<script src="https://<host>/api/radio-client.js"></script>
```

The script is served from `GET /api/radio-client.js` and exposes a global `RadioClient` constructor.

### Initialization

```javascript
const radio = new RadioClient();

await radio.init({
  serverUrl: 'https://<host>',   // Required: radio server URL
  channelId: 'North__Dispatch',  // Optional: initial channel (room_key format)
});
```

`init()` performs the following steps:
1. Fetches user info from `GET /api/auth/me` (requires prior `cad-login`).
2. Connects to the Socket.IO signaling server at `/signaling`.
3. Sends `authenticate` event with the user's identity.
4. Initializes audio playback (WebAudio API).
5. If `channelId` is provided, joins the channel and opens the Audio WebSocket.

### Methods

| Method | Signature | Description |
|---|---|---|
| `init` | `init(options): Promise<void>` | Initialize the client. `options: { serverUrl: string, channelId?: string }` |
| `startPtt` | `startPtt(): Promise<boolean>` | Request PTT. Returns `true` if granted, `false` if busy. Starts mic capture on grant. |
| `stopPtt` | `stopPtt(): Promise<void>` | Release PTT and stop mic capture. |
| `setChannel` | `setChannel(channelId): Promise<void>` | Switch to a different channel. Stops any active PTT, leaves old channel, joins new. |
| `getZones` | `getZones(): Promise<object>` | Fetch all zones with channels from `/api/cad-integration/zones`. |
| `getChannels` | `getChannels(zone?): Promise<object>` | Fetch channels, optionally filtered by zone, from `/api/cad-integration/channels`. |
| `on` | `on(event, callback): RadioClient` | Register an event listener. Returns `this` for chaining. |
| `off` | `off(event, callback): RadioClient` | Remove an event listener. |
| `destroy` | `destroy(): Promise<void>` | Clean up all resources (sockets, audio, media streams). |
| `isTransmitting` | `isTransmitting(): boolean` | Whether the client is currently transmitting. |
| `isConnected` | `isConnected(): boolean` | Whether the client is connected and authenticated. |
| `getChannelId` | `getChannelId(): string\|null` | Get the current channel ID. |
| `getUnitId` | `getUnitId(): string\|null` | Get the current unit ID. |
| `getUsername` | `getUsername(): string\|null` | Get the current username. |

### Events

| Event Name | Payload | Description |
|---|---|---|
| `pttStart` | `{ unitId, channelId, timestamp, isEmergency }` | A unit started transmitting |
| `pttEnd` | `{ unitId, channelId, timestamp, duration, gracePeriodMs }` | A unit stopped transmitting |
| `pttBusy` | `{ channelId, transmittingUnit, inGracePeriod? }` | PTT denied — channel busy |
| `pttGranted` | `{ channelId, unitId, timestamp }` | PTT granted to you |
| `connectionChange` | `{ connected: boolean, reason? }` | Socket connection state changed |
| `channelJoin` | `{ unitId, channelId, timestamp }` | A unit joined the channel |
| `channelLeave` | `{ unitId, channelId, timestamp }` | A unit left the channel |
| `channelMembers` | `{ channelId, members: [...] }` | Channel member list |
| `emergencyStart` | `{ channelId, unitId, ... }` | Emergency declared |
| `emergencyEnd` | `{ channelId, unitId, ... }` | Emergency ended |

### Example: Full Integration

```javascript
// 1. Your CAD backend calls cad-login to create a session (server-side)
//    POST https://<radio-host>/api/auth/cad-login
//    Headers: { "x-radio-api-key": "<key>", "Content-Type": "application/json" }
//    Body: { "username": "officer1" }
//    Forward the connect.sid cookie to the CAD frontend

// 2. CAD frontend loads the radio client
// <script src="https://<radio-host>/api/radio-client.js"></script>

// 3. Initialize
const radio = new RadioClient();
await radio.init({ serverUrl: 'https://<radio-host>' });

// 4. Populate channel selector
const zonesData = await radio.getZones();
zonesData.zones.forEach(zone => {
  zone.channels.forEach(ch => {
    // Add ch.room_key to dropdown, display ch.name
  });
});

// 5. Set channel
await radio.setChannel('North__Dispatch');

// 6. Wire PTT button
pttBtn.addEventListener('mousedown', () => radio.startPtt());
pttBtn.addEventListener('mouseup', () => radio.stopPtt());

// 7. Listen for events
radio.on('pttStart', (data) => { /* show "transmitting" UI */ });
radio.on('pttEnd', (data) => { /* show "idle" UI */ });
radio.on('pttBusy', (data) => { /* show "channel busy" UI */ });

// 8. Clean up when done
radio.destroy();
```

---

## Changelog / Maintenance

> **IMPORTANT:** This file must be updated whenever API changes are made. This includes:
> - Adding, removing, or modifying any REST endpoint
> - Changing Socket.IO event names or payload shapes
> - Changing the Audio WebSocket protocol or binary packet format
> - Changing authentication requirements or mechanisms
> - Changing rate limits or other server configuration
> - Updating the RadioClient API or events
>
> When making changes, update the relevant section(s) and set the `Last Updated` date at the top of this document.

### Version History

| Date | Change |
|---|---|
| 2026-04-11 | Full documentation audit. Added 4 missing endpoint families: Unit Endpoints (`/api/unit/*` — 3 endpoints), Radio Config Endpoints (`/api/radio/*` — 1 endpoint), Recording Log Endpoints (`/api/recording-logs/*` — 4 endpoints), Admin Endpoints (`/api/admin/*` — 24 endpoints). Added 2 missing Socket.IO outbound events: `tx:silence_warning` and `radio:dsp_config`. Updated Auth Modes Summary table to include new endpoint families. Updated Table of Contents. |
| 2026-04-10 | Audio WebSocket: Added Opus end-to-end passthrough (`0x02` marker). Server now sends Opus frames by default instead of PCM. Clients may TX with either `0x02` (Opus, preferred) or `0x01` (PCM, legacy). Updated Audio Specification table. |
| 2026-04-10 | Initial version — complete API reference covering all endpoints, Socket.IO events, Audio WebSocket protocol, and embeddable RadioClient. |
