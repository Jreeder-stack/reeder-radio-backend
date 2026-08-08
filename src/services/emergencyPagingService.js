import {
  createPage,
  getAllFcmTokensForUnit,
  getPagingChannelId,
  getApnsTokensForUnitId,
} from '../db/index.js';
import { sendPageToTokens } from './fcmService.js';
import { sendApnsToTokens, buildPagePayload } from './apnsService.js';

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function unique(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

async function sendToUnit(unitId, message, sender, pagingChannelId) {
  const page = await createPage(message, sender, 'unit', unitId);

  const fcmRows = await getAllFcmTokensForUnit(unitId).catch(() => []);
  const fcmTokens = unique(fcmRows.map((row) => row.fcm_token));
  const fcm = fcmTokens.length
    ? await sendPageToTokens(fcmTokens, page.id, message, sender, pagingChannelId)
    : { successCount: 0, failureCount: 0 };

  const apnsRows = await getApnsTokensForUnitId(unitId).catch(() => []);
  const apnsTokens = unique(apnsRows.map((row) => row.token));
  const apns = apnsTokens.length
    ? await sendApnsToTokens(
      apnsTokens,
      buildPagePayload({ pageId: page.id, message, sender, pagingChannelId }),
      { collapseId: `page-${page.id}`, pushType: 'alert', priority: 10 },
    )
    : { successCount: 0, failureCount: 0 };

  return {
    unitId,
    pageId: page.id,
    targetedDeviceCount: fcmTokens.length + apnsTokens.length,
    successCount: Number(fcm.successCount || 0) + Number(apns.successCount || 0),
    failureCount: Number(fcm.failureCount || 0) + Number(apns.failureCount || 0),
  };
}

/**
 * Sends a real Command Communications page to a center-scoped list of unit
 * callsigns. The caller is responsible for supplying only units belonging to
 * the active AI dispatch center. This deliberately avoids the older global
 * paging-list lookup so one AI dispatcher can never spill an emergency page
 * into another dispatch center.
 */
export async function pageEmergencyUnits({ unitIds = [], message, sender = 'AI DISPATCHER' } = {}) {
  const recipients = unique(unitIds);
  const body = clean(message);
  if (!body || recipients.length === 0) {
    return { attempted: 0, delivered: 0, failed: 0, results: [] };
  }

  const pagingChannelId = await getPagingChannelId().catch(() => null);
  const settled = await Promise.allSettled(
    recipients.map((unitId) => sendToUnit(unitId, body, sender, pagingChannelId)),
  );

  const results = settled.map((entry, index) => {
    if (entry.status === 'fulfilled') return entry.value;
    return {
      unitId: recipients[index],
      pageId: null,
      targetedDeviceCount: 0,
      successCount: 0,
      failureCount: 1,
      error: entry.reason?.message || 'Emergency page failed',
    };
  });

  return {
    attempted: recipients.length,
    delivered: results.filter((item) => item.successCount > 0).length,
    failed: results.filter((item) => item.successCount <= 0).length,
    results,
  };
}
