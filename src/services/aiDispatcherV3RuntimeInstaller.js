import pool from '../db/index.js';
import { aiDispatcherRuntimeManager } from './aiDispatcherRuntimeManager.js';
import { signalingService } from './signalingService.js';
import { CORE_AI_DISPATCHER_CAD_SCOPES, validateDispatcherCadIntegration } from './cadService.js';
import { getConfiguredDispatcherRuntime, DISPATCHER_RUNTIME } from '../dispatcher-v3/runtimeSelector.js';
import { V3LiveDispatcher } from '../dispatcher-v3/liveRuntime.js';

let installed = false;

export function installAiDispatcherV3Runtime() {
  if (installed) return aiDispatcherRuntimeManager;
  installed = true;

  const legacyStartProfile = aiDispatcherRuntimeManager.startProfile.bind(aiDispatcherRuntimeManager);
  const legacyStopProfile = aiDispatcherRuntimeManager.stopProfile.bind(aiDispatcherRuntimeManager);

  aiDispatcherRuntimeManager.startProfile = async function startProfileV3Aware(id) {
    if (getConfiguredDispatcherRuntime() !== DISPATCHER_RUNTIME.V3) return legacyStartProfile(id);
    await this.ensureSchema();
    if (this.runtimes.has(id)) return this.runtimes.get(id);
    const profile = await this.getProfileRow(id);
    if (!profile) throw Object.assign(new Error('AI dispatcher profile not found'), { statusCode: 404 });
    if (!profile.dispatch_center_id || !profile.channel_id || !profile.room_key) {
      throw Object.assign(new Error('Profile requires a dispatch center and radio channel'), { statusCode: 400 });
    }

    try {
      const requiredCadScopes = [
        ...CORE_AI_DISPATCHER_CAD_SCOPES,
        ...(profile.status_checks_enabled !== false ? ['status_check.read', 'status_check.write'] : []),
      ];
      const cadPreflight = await validateDispatcherCadIntegration({ requiredScopes: requiredCadScopes });
      if (!cadPreflight.success) {
        const error = new Error(`CAD readiness check failed at ${cadPreflight.stage || 'unknown'}: ${cadPreflight.error || 'unknown error'}`);
        error.statusCode = cadPreflight.statusCode || 503;
        error.cadPreflight = cadPreflight;
        throw error;
      }

      const context = this._runtimeContext(profile);
      const dispatcher = new V3LiveDispatcher({ runtimeContext: context, scopes: cadPreflight.scopes || requiredCadScopes });
      await dispatcher.start();
      const subscriptions = [];
      const allowed = (data) => dispatcher.matchesChannel(data.channelId);
      subscriptions.push(signalingService.onPttStart(async (data) => {
        if (allowed(data)) await dispatcher.handlePttStart(data.channelId, data.unitId, data.isEmergency);
      }));
      subscriptions.push(signalingService.onPttEnd(async (data) => {
        if (allowed(data)) await dispatcher.handlePttEnd(data.channelId, data.unitId, data.gracePeriodMs);
      }));
      subscriptions.push(signalingService.onEmergencyStart(async (data) => {
        if (allowed(data)) await dispatcher.handleEmergencyStart(data.channelId, data.unitId);
      }));
      subscriptions.push(signalingService.onEmergencyEnd(async (data) => {
        if (allowed(data)) await dispatcher.handleEmergencyEnd(data.channelId, data.unitId);
      }));

      const runtime = { kind: 'v3', profile, context: dispatcher.context, dispatcher, adapter: null, subscriptions, startedAt: new Date().toISOString() };
      this.runtimes.set(id, runtime);
      await pool.query('UPDATE ai_dispatcher_profiles SET enabled=TRUE,last_started_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1', [id]);
      this.log('PROFILE_STARTED_V3', { id, name: profile.name, center: profile.dispatch_center_id, channel: profile.room_key, identity: profile.identity, scopes: cadPreflight.scopes });
      return runtime;
    } catch (error) {
      await pool.query('UPDATE ai_dispatcher_profiles SET last_error=$2,updated_at=NOW() WHERE id=$1', [id, error.message]).catch(() => {});
      this.log('PROFILE_START_V3_FAILED', { id, error: error.message });
      throw error;
    }
  };

  aiDispatcherRuntimeManager.stopProfile = async function stopProfileV3Aware(id, { persist = true } = {}) {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.kind !== 'v3') return legacyStopProfile(id, { persist });
    for (const unsubscribe of runtime.subscriptions || []) {
      try { unsubscribe(); } catch (_) {}
    }
    await runtime.dispatcher.stop();
    this.runtimes.delete(id);
    this.log('PROFILE_STOPPED_V3', { id });
    if (persist) await pool.query('UPDATE ai_dispatcher_profiles SET enabled=FALSE,last_stopped_at=NOW(),updated_at=NOW() WHERE id=$1', [id]);
    else await pool.query('UPDATE ai_dispatcher_profiles SET last_stopped_at=NOW(),updated_at=NOW() WHERE id=$1', [id]).catch(() => {});
    return true;
  };

  aiDispatcherRuntimeManager.log('V3_RUNTIME_INSTALLER_ACTIVE', { selectedRuntime: getConfiguredDispatcherRuntime() });
  return aiDispatcherRuntimeManager;
}
