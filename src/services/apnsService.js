import http2 from 'http2';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { deleteApnsTokenByToken } from '../db/index.js';

let cachedJwt = null;
let cachedJwtAt = 0;
let session = null;

function loadKey() {
  const inline = process.env.APNS_KEY_P8;
  if (inline && inline.trim().length > 0) {
    return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
  }
  const path = process.env.APNS_KEY_PATH;
  if (path && existsSync(path)) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      console.warn('[APNs] Failed to read APNS_KEY_PATH:', err.message);
      return null;
    }
  }
  return null;
}

export function isApnsEnabled() {
  return !!(
    process.env.APNS_KEY_ID &&
    process.env.APNS_TEAM_ID &&
    process.env.APNS_BUNDLE_ID &&
    loadKey()
  );
}

function getHost() {
  return process.env.APNS_PRODUCTION === 'true'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}

function generateJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwtAt < 50 * 60) return cachedJwt;
  const key = loadKey();
  if (!key) throw new Error('APNS key not available');
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID })
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: now })
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  const token = `${signingInput}.${sig.toString('base64url')}`;
  cachedJwt = token;
  cachedJwtAt = now;
  return token;
}

function ensureSession() {
  if (session && !session.closed && !session.destroyed) return session;
  const s = http2.connect(getHost());
  s.on('error', (err) => {
    console.warn('[APNs] HTTP/2 session error:', err.message);
    try { s.close(); } catch (_) {}
    if (session === s) session = null;
  });
  s.on('close', () => {
    if (session === s) session = null;
  });
  session = s;
  return s;
}

/**
 * Send a single APNs notification.
 * Returns { ok, status, reason }.
 * Stale tokens (Unregistered / BadDeviceToken / 410) are auto-removed from DB.
 */
export async function sendApnsNotification(deviceToken, payload, opts = {}) {
  if (!isApnsEnabled()) {
    return { ok: false, status: 0, reason: 'APNS_DISABLED' };
  }
  if (!deviceToken) {
    return { ok: false, status: 0, reason: 'NO_TOKEN' };
  }

  const {
    collapseId = null,
    pushType = 'alert',
    priority = 10,
    expiration = 0,
  } = opts;

  let jwt;
  try {
    jwt = generateJwt();
  } catch (err) {
    console.warn('[APNs] JWT generation failed:', err.message);
    return { ok: false, status: 0, reason: 'JWT_ERROR' };
  }

  const body = Buffer.from(JSON.stringify(payload));
  const sess = ensureSession();

  return await new Promise((resolve) => {
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      'apns-push-type': pushType,
      'apns-priority': String(priority),
      'apns-expiration': String(expiration),
      'content-type': 'application/json',
      'content-length': String(body.length),
    };
    if (collapseId) headers['apns-collapse-id'] = collapseId;

    let req;
    try {
      req = sess.request(headers);
    } catch (err) {
      console.warn('[APNs] request setup failed:', err.message);
      return resolve({ ok: false, status: 0, reason: err.message });
    }

    let data = '';
    let status = 0;
    req.on('response', (h) => {
      status = h[':status'];
    });
    req.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    req.on('end', async () => {
      let reason = null;
      try {
        reason = JSON.parse(data || '{}').reason || null;
      } catch (_) {}

      if (status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken') {
        try {
          await deleteApnsTokenByToken(deviceToken);
          console.log(`[APNs] Removed stale token ${deviceToken.slice(0, 12)}... (${reason || status})`);
        } catch (err) {
          console.warn('[APNs] Failed to remove stale token:', err.message);
        }
      }
      resolve({ ok: status >= 200 && status < 300, status, reason });
    });
    req.on('error', (err) => {
      console.warn('[APNs] request error:', err.message);
      resolve({ ok: false, status: 0, reason: err.message });
    });

    req.end(body);
  });
}

export async function sendApnsToTokens(tokens, payload, opts) {
  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, results: [] };
  }
  if (!isApnsEnabled()) {
    console.warn('[APNs] sendApnsToTokens called but APNs not configured — skipping');
    return { successCount: 0, failureCount: tokens.length, results: [] };
  }

  let successCount = 0;
  let failureCount = 0;
  const results = [];
  for (const token of tokens) {
    const r = await sendApnsNotification(token, payload, opts);
    results.push({ token, ...r });
    if (r.ok) successCount++;
    else failureCount++;
  }
  return { successCount, failureCount, results };
}

/**
 * Build a standard page-alert payload.
 */
export function buildPagePayload({ pageId, message, sender, pagingChannelId, audioUrl }) {
  return {
    aps: {
      alert: {
        title: `Page from ${sender || 'Dispatch'}`,
        body: message,
      },
      sound: 'default',
      'content-available': 1,
    },
    type: 'page',
    pageId: pageId != null ? String(pageId) : '',
    message: message || '',
    sender: sender || '',
    pagingChannelId: pagingChannelId != null ? String(pagingChannelId) : '',
    ...(audioUrl ? { audioUrl: String(audioUrl) } : {}),
  };
}

/**
 * Build a standard emergency-alert payload.
 */
export function buildEmergencyPayload({ unitId, channelId, message }) {
  return {
    aps: {
      alert: {
        title: 'EMERGENCY',
        body: message || `Unit ${unitId} activated emergency on ${channelId}`,
      },
      sound: 'default',
      'interruption-level': 'critical',
      'content-available': 1,
    },
    type: 'emergency',
    unitId: unitId || '',
    channelId: channelId || '',
  };
}

export function shutdownApns() {
  if (session) {
    try { session.close(); } catch (_) {}
    session = null;
  }
}
