import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  getPagingListMembers,
  getPagingListByType,
  getAllFcmTokensForUnit,
  getPagingChannelId,
  createPage,
} from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let app = null;

function loadServiceAccount() {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv && jsonEnv.trim().length > 0) {
    try {
      return { sa: JSON.parse(jsonEnv), source: 'FIREBASE_SERVICE_ACCOUNT_JSON' };
    } catch (err) {
      console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT_JSON is set but not valid JSON:', err.message);
      return null;
    }
  }

  const pathEnv = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (pathEnv && pathEnv.trim().length > 0) {
    try {
      if (!existsSync(pathEnv)) {
        console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT_PATH set but file not found:', pathEnv);
        return null;
      }
      return { sa: JSON.parse(readFileSync(pathEnv, 'utf8')), source: `FIREBASE_SERVICE_ACCOUNT_PATH (${pathEnv})` };
    } catch (err) {
      console.warn('[FCM] Failed to read FIREBASE_SERVICE_ACCOUNT_PATH:', err.message);
      return null;
    }
  }

  return null;
}

function initFcm() {
  if (app) return app;

  const googleServicesPath = join(__dirname, '../../android-native/app/google-services.json');
  let googleServicesProjectId = null;
  if (existsSync(googleServicesPath)) {
    try {
      const googleServices = JSON.parse(readFileSync(googleServicesPath, 'utf8'));
      googleServicesProjectId = googleServices.project_info?.project_id || null;
    } catch (err) {
      console.warn('[FCM] Could not parse google-services.json:', err.message);
    }
  } else {
    console.warn('[FCM] google-services.json not found at', googleServicesPath);
  }

  const loaded = loadServiceAccount();

  try {
    if (admin.apps.length > 0) {
      app = admin.apps[0];
      return app;
    }

    if (loaded) {
      const { sa, source } = loaded;
      const projectId = sa.project_id || googleServicesProjectId;
      if (!projectId) {
        console.warn('[FCM] No project_id found in service account or google-services.json — FCM disabled');
        return null;
      }
      app = admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId,
      });
      console.log(`[FCM] Firebase Admin SDK initialized from ${source} for project:`, projectId);
      return app;
    }

    console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT_JSON / FIREBASE_SERVICE_ACCOUNT_PATH not set — falling back to applicationDefault(). Push will fail on non-GCP hosts. To enable FCM, generate a Firebase Admin service account JSON (Firebase Console → Project Settings → Service Accounts → Generate New Private Key) and store it in the FIREBASE_SERVICE_ACCOUNT_JSON secret.');

    if (!googleServicesProjectId) {
      console.warn('[FCM] Could not determine project_id — FCM disabled');
      return null;
    }

    app = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: googleServicesProjectId,
    });
    console.log('[FCM] Firebase Admin SDK initialized via applicationDefault() for project:', googleServicesProjectId);
    return app;
  } catch (err) {
    console.warn('[FCM] Failed to initialize Firebase Admin SDK:', err.message, '— FCM disabled');
    return null;
  }
}

export async function sendPageToTokens(tokens, pageId, message, sender, pagingChannelId) {
  const firebaseApp = initFcm();
  if (!firebaseApp) {
    console.warn('[FCM] sendPageToTokens called but FCM not initialized — skipping');
    return { successCount: 0, failureCount: tokens.length, results: [] };
  }

  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, results: [] };
  }

  const messaging = admin.messaging(firebaseApp);

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const token of tokens) {
    try {
      await messaging.send({
        token,
        data: {
          type: 'page',
          pageId: String(pageId),
          message,
          sender,
          pagingChannelId: pagingChannelId ? String(pagingChannelId) : '',
        },
        android: {
          priority: 'high',
          ttl: 60000,
        },
      });
      results.push({ token, success: true });
      successCount++;
    } catch (err) {
      console.warn('[FCM] Failed to send to token:', token.slice(0, 20) + '...', err.message);
      results.push({ token, success: false, error: err.message });
      failureCount++;
    }
  }

  console.log(`[FCM] Page ${pageId} sent: ${successCount} success, ${failureCount} failed`);
  return { successCount, failureCount, results };
}

/**
 * Send a page to every member of an admin-managed paging list (e.g. 'backup_request', 'emergency').
 * Used by AI dispatch flows so they don't have to wire roster lookup + FCM delivery themselves.
 *
 * Returns { listType, memberCount, tokenCount, page, fcm }.
 * If the roster is empty or no members have FCM tokens, the page row is still recorded but no
 * FCM messages are sent.
 */
export async function sendPageToList(listType, message, sender) {
  if (!listType) throw new Error('listType is required');
  if (!message) throw new Error('message is required');
  const senderName = sender || 'AI-DISPATCH';

  const list = await getPagingListByType(listType);
  if (!list) {
    throw new Error(`Unknown paging list type: ${listType}`);
  }

  const members = await getPagingListMembers(listType);
  if (!members || members.length === 0) {
    console.warn(`[FCM] sendPageToList: paging list "${listType}" has no members — nothing to page`);
  }

  const tokenSet = new Map();
  for (const member of members) {
    if (!member.unit_id) continue;
    const rows = await getAllFcmTokensForUnit(member.unit_id);
    for (const row of rows) {
      if (row.fcm_token) tokenSet.set(row.fcm_token, row);
    }
  }
  const tokens = Array.from(tokenSet.keys());

  const page = await createPage(message, senderName, 'list', listType);
  const pagingChannelId = await getPagingChannelId();

  if (tokens.length === 0) {
    console.warn(`[FCM] sendPageToList: no FCM tokens for list "${listType}" (members=${members.length}) — page recorded id=${page.id} but not delivered`);
    return {
      listType,
      memberCount: members.length,
      tokenCount: 0,
      page,
      fcm: { successCount: 0, failureCount: 0, results: [] },
    };
  }

  const fcmResult = await sendPageToTokens(tokens, page.id, message, senderName, pagingChannelId);
  console.log(`[FCM] sendPageToList "${listType}": members=${members.length} tokens=${tokens.length} success=${fcmResult.successCount} failure=${fcmResult.failureCount} pageId=${page.id}`);
  return {
    listType,
    memberCount: members.length,
    tokenCount: tokens.length,
    page,
    fcm: fcmResult,
  };
}
