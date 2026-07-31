import crypto from 'crypto';
import pool, { getAiDispatchChannel, getAllChannels, isAiDispatchEnabled, getStatusChecksEnabledState } from '../db/index.js';
import { AIDispatcher } from './aiDispatchService.js';
import { AIDispatcherSignaling } from './aiDispatcherSignaling.js';
import { signalingService } from './signalingService.js';
import { isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { bindRuntime, runWithRuntime } from './runtimeContext.js';

const UNIT_CACHE_TTL_MS = 15000;

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function publicProfile(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    channelId: row.channel_id,
    channelName: row.channel_name,
    roomKey: row.room_key,
    dispatchCenterId: row.dispatch_center_id,
    dispatchCenterName: row.dispatch_center_name,
    dispatchCenterCode: row.dispatch_center_code,
    agencyId: row.agency_id,
    identity: row.identity,
    statusChecksEnabled: row.status_checks_enabled !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastStartedAt: row.last_started_at,
    lastStoppedAt: row.last_stopped_at,
    lastError: row.last_error,
  };
}

export class AIDispatcherRuntimeManager {
  constructor() {
    this.runtimes = new Map();
    this.unitAccessCache = new Map();
    this.initialized = false;
    this._schemaPromise = null;
  }

  log(action, details = {}) {
    console.log(`[AI-Runtime-Manager] ${new Date().toISOString()} | ${action}`, JSON.stringify(details));
  }

  async ensureSchema() {
    if (this._schemaPromise) return this._schemaPromise;
    this._schemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_dispatcher_profiles (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
          channel_name VARCHAR(120),
          room_key VARCHAR(255),
          dispatch_center_id VARCHAR(64),
          dispatch_center_name VARCHAR(255),
          dispatch_center_code VARCHAR(32),
          agency_id VARCHAR(64),
          identity VARCHAR(120) NOT NULL UNIQUE,
          status_checks_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          last_started_at TIMESTAMPTZ,
          last_stopped_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT ai_dispatcher_profile_center_channel_unique UNIQUE(dispatch_center_id, channel_id)
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_dispatcher_profiles_enabled ON ai_dispatcher_profiles(enabled)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_dispatcher_profiles_center ON ai_dispatcher_profiles(dispatch_center_id)');
      await this._migrateLegacyProfile();
    })().catch((error) => {
      this._schemaPromise = null;
      throw error;
    });
    return this._schemaPromise;
  }

  async _migrateLegacyProfile() {
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM ai_dispatcher_profiles');
    if ((count.rows[0]?.count || 0) > 0) return;

    const enabled = await isAiDispatchEnabled().catch(() => false);
    const configuredChannel = await getAiDispatchChannel().catch(() => null);
    const channels = await getAllChannels().catch(() => []);
    const channel = channels.find((item) => item.room_key === configuredChannel || item.name === configuredChannel) || null;
    const statusSetting = await getStatusChecksEnabledState().catch(() => ({ enabled: true }));

    let center = null;
    const envCenter = clean(process.env.CAD_DISPATCH_CENTER_ID);
    if (envCenter) {
      center = { id: envCenter, name: process.env.CAD_DISPATCH_CENTER_NAME || null, code: process.env.CAD_DISPATCH_CENTER_CODE || null };
    } else {
      const centers = await pool.query(`
        SELECT dispatch_center_id AS id,
               MAX(dispatch_center_name) AS name,
               MAX(dispatch_center_code) AS code
        FROM (
          SELECT dispatch_center_id, dispatch_center_name, dispatch_center_code FROM users WHERE dispatch_center_id IS NOT NULL
          UNION ALL
          SELECT dispatch_center_id, dispatch_center_name, dispatch_center_code FROM radios WHERE dispatch_center_id IS NOT NULL
          UNION ALL
          SELECT dispatch_center_id, dispatch_center_name, dispatch_center_code FROM units WHERE dispatch_center_id IS NOT NULL
        ) assigned
        GROUP BY dispatch_center_id
      `).catch(() => ({ rows: [] }));
      if (centers.rows.length === 1) center = centers.rows[0];
    }

    const id = crypto.randomUUID();
    const complete = !!(channel && center?.id);
    await pool.query(`
      INSERT INTO ai_dispatcher_profiles (
        id, name, enabled, channel_id, channel_name, room_key,
        dispatch_center_id, dispatch_center_name, dispatch_center_code,
        agency_id, identity, status_checks_enabled, last_error
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      id,
      'Primary AI Dispatcher',
      enabled && complete,
      channel?.id || null,
      channel?.name || clean(configuredChannel),
      channel?.room_key || clean(configuredChannel),
      center?.id || null,
      center?.name || null,
      center?.code || null,
      clean(process.env.CAD_AGENCY_ID),
      `AI-DISPATCHER:${id.slice(0, 8).toUpperCase()}`,
      statusSetting.enabled !== false,
      complete ? null : 'Select a radio channel and Command Link dispatch center before enabling this profile.',
    ]);
    this.log('LEGACY_PROFILE_MIGRATED', { enabled: enabled && complete, channel: channel?.room_key, dispatchCenterId: center?.id || null });
  }

  async initialize() {
    await this.ensureSchema();
    if (this.initialized) return this.listProfilesWithStatus();
    this.initialized = true;
    const profiles = await this._listRows();
    for (const profile of profiles) {
      if (profile.enabled) await this.startProfile(profile.id).catch(() => {});
    }
    return this.listProfilesWithStatus();
  }

  async shutdown() {
    const ids = [...this.runtimes.keys()];
    await Promise.allSettled(ids.map((id) => this.stopProfile(id, { persist: false })));
    this.initialized = false;
  }

  async _listRows() {
    await this.ensureSchema();
    const result = await pool.query('SELECT * FROM ai_dispatcher_profiles ORDER BY created_at, name');
    return result.rows;
  }

  async getProfileRow(id) {
    await this.ensureSchema();
    const result = await pool.query('SELECT * FROM ai_dispatcher_profiles WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async listProfilesWithStatus() {
    const rows = await this._listRows();
    return rows.map((row) => {
      const runtime = this.runtimes.get(row.id);
      return {
        ...publicProfile(row),
        runtime: runtime ? {
          state: runtime.dispatcher.connected ? 'connected' : runtime.dispatcher.isRunning ? 'starting' : 'stopped',
          pipeline: runtime.dispatcher.getPipelineStatus(),
          startedAt: runtime.startedAt,
        } : { state: row.enabled ? 'not_running' : 'disabled', pipeline: null, startedAt: null },
      };
    });
  }

  async fetchCadCenters() {
    const cadUrl = clean(process.env.CAD_URL)?.replace(/\/+$/, '');
    const apiKey = clean(process.env.CAD_API_KEY);
    if (!cadUrl || !apiKey) throw Object.assign(new Error('CAD integration is not configured'), { statusCode: 503 });
    const response = await fetch(`${cadUrl}/api/radio/dispatch-centers`, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `CAD returned HTTP ${response.status}`), { statusCode: response.status });
    return Array.isArray(body.dispatchCenters) ? body.dispatchCenters : [];
  }

  async getCatalog() {
    const [channels, dispatchCenters] = await Promise.all([getAllChannels(), this.fetchCadCenters()]);
    return { channels: channels.filter((channel) => channel.enabled), dispatchCenters };
  }

  async _normalizeInput(input, existing = null) {
    const channels = await getAllChannels();
    const requestedChannel = input.channelId ?? input.channel_id ?? input.channel ?? existing?.channel_id ?? existing?.room_key;
    const channel = channels.find((item) => String(item.id) === String(requestedChannel) || item.room_key === requestedChannel || item.name === requestedChannel);
    if (!channel) throw Object.assign(new Error('Select a valid enabled radio channel'), { statusCode: 400 });

    const centers = await this.fetchCadCenters();
    const centerId = clean(input.dispatchCenterId ?? input.dispatch_center_id ?? existing?.dispatch_center_id);
    const center = centers.find((item) => String(item.id) === String(centerId));
    if (!center) throw Object.assign(new Error('Select a valid Command Link dispatch center'), { statusCode: 400 });

    const agencies = Array.isArray(center.agencies) ? center.agencies : [];
    let agencyId = clean(input.agencyId ?? input.agency_id ?? existing?.agency_id ?? center.defaultAgencyId);
    if (agencyId && agencies.length && !agencies.some((agency) => String(agency.id) === String(agencyId))) {
      throw Object.assign(new Error('Selected agency is not assigned to that dispatch center'), { statusCode: 400 });
    }
    if (!agencyId && agencies.length === 1) agencyId = String(agencies[0].id);

    const name = clean(input.name ?? existing?.name) || `${center.name || center.code} AI Dispatcher`;
    const enabled = input.enabled === undefined ? !!existing?.enabled : !!input.enabled;
    const statusChecksEnabled = input.statusChecksEnabled === undefined && input.status_checks_enabled === undefined
      ? existing?.status_checks_enabled !== false
      : !!(input.statusChecksEnabled ?? input.status_checks_enabled);

    return {
      name,
      enabled,
      channelId: channel.id,
      channelName: channel.name,
      roomKey: channel.room_key || `${channel.zone || 'Default'}__${channel.name}`,
      dispatchCenterId: String(center.id),
      dispatchCenterName: center.name || null,
      dispatchCenterCode: center.code || null,
      agencyId,
      statusChecksEnabled,
    };
  }

  async createProfile(input) {
    await this.ensureSchema();
    const normalized = await this._normalizeInput(input || {});
    const id = crypto.randomUUID();
    const identity = `AI-DISPATCHER:${id.slice(0, 8).toUpperCase()}`;
    const result = await pool.query(`
      INSERT INTO ai_dispatcher_profiles (
        id, name, enabled, channel_id, channel_name, room_key,
        dispatch_center_id, dispatch_center_name, dispatch_center_code,
        agency_id, identity, status_checks_enabled, last_error, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,NOW())
      RETURNING *
    `, [id, normalized.name, normalized.enabled, normalized.channelId, normalized.channelName, normalized.roomKey,
      normalized.dispatchCenterId, normalized.dispatchCenterName, normalized.dispatchCenterCode,
      normalized.agencyId, identity, normalized.statusChecksEnabled]);
    if (normalized.enabled) await this.startProfile(id);
    return publicProfile(result.rows[0]);
  }

  async updateProfile(id, input) {
    const existing = await this.getProfileRow(id);
    if (!existing) throw Object.assign(new Error('AI dispatcher profile not found'), { statusCode: 404 });
    const normalized = await this._normalizeInput(input || {}, existing);
    await this.stopProfile(id, { persist: false });
    const result = await pool.query(`
      UPDATE ai_dispatcher_profiles SET
        name=$2, enabled=$3, channel_id=$4, channel_name=$5, room_key=$6,
        dispatch_center_id=$7, dispatch_center_name=$8, dispatch_center_code=$9,
        agency_id=$10, status_checks_enabled=$11, last_error=NULL, updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [id, normalized.name, normalized.enabled, normalized.channelId, normalized.channelName, normalized.roomKey,
      normalized.dispatchCenterId, normalized.dispatchCenterName, normalized.dispatchCenterCode,
      normalized.agencyId, normalized.statusChecksEnabled]);
    if (normalized.enabled) await this.startProfile(id);
    return publicProfile(result.rows[0]);
  }

  async deleteProfile(id) {
    await this.stopProfile(id, { persist: false });
    const result = await pool.query('DELETE FROM ai_dispatcher_profiles WHERE id=$1 RETURNING id', [id]);
    if (!result.rows[0]) throw Object.assign(new Error('AI dispatcher profile not found'), { statusCode: 404 });
    return true;
  }

  _runtimeContext(profile) {
    return {
      runtimeId: profile.id,
      profileId: profile.id,
      profileName: profile.name,
      dispatchCenterId: profile.dispatch_center_id,
      dispatchCenterName: profile.dispatch_center_name,
      agencyId: profile.agency_id,
      cadUrl: process.env.CAD_URL,
      cadApiKey: process.env.CAD_API_KEY,
      channelId: profile.channel_id,
      channelName: profile.channel_name,
      roomKey: profile.room_key,
      identity: profile.identity,
      managed: true,
    };
  }

  async isUnitAllowed(dispatchCenterId, unitId) {
    if (!dispatchCenterId || !unitId) return false;
    const normalizedUnit = String(unitId).trim().toUpperCase();
    if (!normalizedUnit || normalizedUnit.startsWith('AI-')) return false;
    const key = `${dispatchCenterId}|${normalizedUnit}`;
    const cached = this.unitAccessCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.allowed;
    const result = await pool.query(`
      SELECT 1 FROM users WHERE UPPER(unit_id)=UPPER($1) AND dispatch_center_id=$2
      UNION ALL
      SELECT 1 FROM radios WHERE UPPER(radio_id)=UPPER($1) AND dispatch_center_id=$2
      UNION ALL
      SELECT 1 FROM units WHERE UPPER(unit_identity)=UPPER($1) AND dispatch_center_id=$2
      LIMIT 1
    `, [normalizedUnit, dispatchCenterId]).catch(() => ({ rows: [] }));
    const allowed = result.rows.length > 0;
    this.unitAccessCache.set(key, { allowed, expiresAt: Date.now() + UNIT_CACHE_TTL_MS });
    return allowed;
  }

  async startProfile(id) {
    await this.ensureSchema();
    if (this.runtimes.has(id)) return this.runtimes.get(id);
    const profile = await this.getProfileRow(id);
    if (!profile) throw Object.assign(new Error('AI dispatcher profile not found'), { statusCode: 404 });
    if (!profile.dispatch_center_id || !profile.channel_id || !profile.room_key) {
      throw Object.assign(new Error('Profile requires a dispatch center and radio channel'), { statusCode: 400 });
    }
    if (!isAzureConfigured()) throw Object.assign(new Error('Azure Speech is not configured'), { statusCode: 503 });

    const context = this._runtimeContext(profile);
    try {
      const runtime = await runWithRuntime(context, async () => {
        const unitAccessGuard = (unitId) => this.isUnitAllowed(profile.dispatch_center_id, unitId);
        const dispatcher = new AIDispatcher({
          profileManaged: true,
          profileId: profile.id,
          profileName: profile.name,
          dispatchCenterId: profile.dispatch_center_id,
          agencyId: profile.agency_id,
          identity: profile.identity,
          statusChecksEnabled: profile.status_checks_enabled,
          runtimeContext: context,
          unitAccessGuard,
        });
        await dispatcher.start(profile.channel_name || profile.room_key, { roomKey: profile.room_key });
        if (!dispatcher.isRunning) throw new Error('Dispatcher did not enter running state');

        const adapter = new AIDispatcherSignaling();
        adapter.initialize(dispatcher);
        for (const alias of dispatcher.channelAliases) adapter.setActiveChannel(alias);
        if (dispatcher.configuredChannel) adapter.setActiveChannel(dispatcher.configuredChannel);
        if (dispatcher.displayChannel) adapter.setActiveChannel(dispatcher.displayChannel);

        const subscriptions = [];
        const allowed = async (data) => dispatcher.matchesChannel(data.channelId) && await unitAccessGuard(data.unitId);
        subscriptions.push(signalingService.onPttStart(bindRuntime(context, async (data) => {
          if (await allowed(data)) await adapter.handlePttStart(data.channelId, data.unitId, data.isEmergency);
        })));
        subscriptions.push(signalingService.onPttEnd(bindRuntime(context, async (data) => {
          if (await allowed(data)) await adapter.handlePttEnd(data.channelId, data.unitId, data.gracePeriodMs);
        })));
        subscriptions.push(signalingService.onEmergencyStart(bindRuntime(context, async (data) => {
          if (await allowed(data)) await adapter.handleEmergencyStart(data.channelId, data.unitId);
        })));
        subscriptions.push(signalingService.onEmergencyEnd(bindRuntime(context, async (data) => {
          if (await allowed(data)) await adapter.handleEmergencyEnd(data.channelId, data.unitId);
        })));

        return { profile, context, dispatcher, adapter, subscriptions, startedAt: new Date().toISOString() };
      });
      this.runtimes.set(id, runtime);
      await pool.query('UPDATE ai_dispatcher_profiles SET enabled=TRUE,last_started_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1', [id]);
      this.log('PROFILE_STARTED', { id, name: profile.name, center: profile.dispatch_center_id, channel: profile.room_key, identity: profile.identity });
      return runtime;
    } catch (error) {
      await pool.query('UPDATE ai_dispatcher_profiles SET last_error=$2,updated_at=NOW() WHERE id=$1', [id, error.message]).catch(() => {});
      this.log('PROFILE_START_FAILED', { id, error: error.message });
      throw error;
    }
  }

  async stopProfile(id, { persist = true } = {}) {
    const runtime = this.runtimes.get(id);
    if (runtime) {
      for (const unsubscribe of runtime.subscriptions || []) {
        try { unsubscribe(); } catch (_) {}
      }
      await runWithRuntime(runtime.context, () => runtime.dispatcher.stop());
      this.runtimes.delete(id);
      this.log('PROFILE_STOPPED', { id });
    }
    if (persist) await pool.query('UPDATE ai_dispatcher_profiles SET enabled=FALSE,last_stopped_at=NOW(),updated_at=NOW() WHERE id=$1', [id]);
    else await pool.query('UPDATE ai_dispatcher_profiles SET last_stopped_at=NOW(),updated_at=NOW() WHERE id=$1', [id]).catch(() => {});
    return true;
  }

  async restartProfile(id) {
    await this.stopProfile(id, { persist: false });
    return this.startProfile(id);
  }

  async getLegacyStatus() {
    const profiles = await this.listProfilesWithStatus();
    const primary = profiles[0] || null;
    return primary ? {
      enabled: primary.enabled,
      channel: primary.roomKey,
      pipeline: primary.runtime?.pipeline || null,
      statusChecksEnabled: primary.statusChecksEnabled,
      statusChecksSource: 'dispatcher_profile',
      profileId: primary.id,
      profileCount: profiles.length,
    } : { enabled: false, channel: null, pipeline: null, statusChecksEnabled: true, statusChecksSource: 'dispatcher_profile', profileId: null, profileCount: 0 };
  }

  async applyLegacySettings({ enabled, channel, statusChecksEnabled }) {
    const rows = await this._listRows();
    let primary = rows[0];
    if (!primary) throw Object.assign(new Error('Create an AI dispatcher profile first'), { statusCode: 400 });
    const updates = {};
    if (enabled !== undefined) updates.enabled = enabled;
    if (channel !== undefined) updates.channel = channel;
    if (statusChecksEnabled !== undefined) updates.statusChecksEnabled = statusChecksEnabled;
    await this.updateProfile(primary.id, updates);
    return this.getLegacyStatus();
  }

  async refreshLearningKnowledge() {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runWithRuntime(runtime.context, () => runtime.dispatcher._refreshLearnedKnowledge?.())));
  }
}

export const aiDispatcherRuntimeManager = new AIDispatcherRuntimeManager();
