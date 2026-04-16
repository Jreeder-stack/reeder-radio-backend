import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let app = null;

function initFcm() {
  if (app) return app;

  const serviceAccountPath = join(__dirname, '../../android-native/app/google-services.json');

  if (!existsSync(serviceAccountPath)) {
    console.warn('[FCM] google-services.json not found at', serviceAccountPath, '— FCM disabled');
    return null;
  }

  try {
    const googleServices = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
    const projectId = googleServices.project_info?.project_id;
    if (!projectId) {
      console.warn('[FCM] Could not find project_id in google-services.json — FCM disabled');
      return null;
    }

    if (admin.apps.length === 0) {
      app = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId,
      });
    } else {
      app = admin.apps[0];
    }
    console.log('[FCM] Firebase Admin SDK initialized for project:', projectId);
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
