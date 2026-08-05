from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    assert count == 1, f"{label}: expected 1 match, found {count}"
    return text.replace(old, new, 1)


service_path = Path('src/services/aiDispatchService.js')
service = service_path.read_text()
service = replace_once(
    service,
    "    this.profileStatusChecksEnabled = options.statusChecksEnabled;\n    this.cadStatusCheckClient = options.cadStatusCheckClient || (",
    "    this.profileStatusChecksEnabled = options.statusChecksEnabled;\n    this.unitAccessGuard = typeof options.unitAccessGuard === 'function' ? options.unitAccessGuard : null;\n    this.cadStatusCheckClient = options.cadStatusCheckClient || (",
    'wire unit access guard',
)
service = replace_once(
    service,
    "    if (this.displayChannel && id === this.displayChannel) return true;",
    "    if (!this.profileManaged && this.displayChannel && id === this.displayChannel) return true;",
    'disable managed bare display alias',
)

pattern = re.compile(r"  async _resolveChannelAliases\(channelName, roomKey\) \{.*?\n  \}\n\n  async start\(channelName, options = \{\}\) \{", re.S)
replacement = r'''  async _resolveChannelAliases(channelName, roomKey) {
    this.channelAliases.clear();
    this.numericChannelId = null;

    const canonicalRoomKey = roomKey ? String(roomKey) : null;
    if (canonicalRoomKey) this.channelAliases.add(canonicalRoomKey);
    else if (channelName) this.channelAliases.add(String(channelName));

    try {
      let result;
      if (canonicalRoomKey) {
        result = await pool.query(
          `SELECT id, name, COALESCE(zone, 'Default') || '__' || name AS room_key
           FROM channels
           WHERE COALESCE(zone, 'Default') || '__' || name = $1
           LIMIT 1`,
          [canonicalRoomKey]
        );
      } else {
        result = await pool.query(
          `SELECT id, name, COALESCE(zone, 'Default') || '__' || name AS room_key
           FROM channels
           WHERE name = $1
           ORDER BY id
           LIMIT 2`,
          [channelName]
        );
        if (result.rows.length > 1) {
          this.log('CHANNEL_ALIAS_AMBIGUOUS', {
            channelName,
            matches: result.rows.map(row => row.room_key),
            action: 'bare_name_rejected',
          });
          return;
        }
      }

      if (result.rows[0]) {
        const row = result.rows[0];
        this.numericChannelId = row.id;
        this.channelAliases.add(String(row.id));
        this.channelAliases.add(row.room_key);
        if (!this.profileManaged && !canonicalRoomKey && row.name) {
          this.channelAliases.add(row.name);
        }
      }
    } catch (err) {
      this.log('CHANNEL_ALIAS_RESOLVE_ERROR', { error: err.message, channelName, roomKey });
    }

    this.log('CHANNEL_ALIASES_RESOLVED', {
      aliases: Array.from(this.channelAliases),
      numericId: this.numericChannelId,
      strictManaged: this.profileManaged,
    });
  }

  async start(channelName, options = {}) {'''
service, count = pattern.subn(replacement, service, count=1)
assert count == 1, f'resolve aliases function: expected 1 match, found {count}'

service = replace_once(
    service,
    "        listenKeys.add(this.channelName);",
    "        if (!this.profileManaged || !this.configuredChannel) listenKeys.add(this.channelName);",
    'health-check listener key',
)
service = replace_once(
    service,
    "    listenKeys.add(channelName);",
    "    if (!this.profileManaged || !this.configuredChannel) listenKeys.add(channelName);",
    'join listener key',
)
service_path.write_text(service)

cad_path = Path('src/services/cadService.js')
cad = cad_path.read_text()
marker = "const DEFAULT_CAD_READ_RETRIES = 3;"
assert cad.count(marker) == 1
helper = r'''export async function checkUnitInCurrentDispatchCenter(unitId) {
  const normalized = String(unitId || '').trim().toUpperCase().replace(/\s+/g, '-');
  const runtime = getRuntimeContext();
  if (!normalized) {
    return {
      allowed: false,
      reason: 'unit_id_required',
      dispatchCenterId: runtime.dispatchCenterId || null,
    };
  }

  const result = await getStatusCheck();
  if (!result || result.success === false) {
    return {
      allowed: false,
      reason: 'cad_unit_read_failed',
      error: result?.error || 'Unable to read CAD units',
      failureType: result?.failureType || null,
      statusCode: result?.statusCode ?? null,
      dispatchCenterId: runtime.dispatchCenterId || null,
    };
  }

  if (!Array.isArray(result.units)) {
    return {
      allowed: false,
      reason: 'malformed_unit_response',
      dispatchCenterId: runtime.dispatchCenterId || null,
    };
  }

  const unit = result.units.find((candidate) => {
    const value = candidate?.unit_id
      || candidate?.unit_number
      || candidate?.unitNumber
      || candidate?.callsign
      || candidate?.call_sign
      || '';
    return String(value).trim().toUpperCase().replace(/\s+/g, '-') === normalized;
  }) || null;

  return {
    allowed: !!unit,
    reason: unit ? 'unit_in_dispatch_center' : 'unit_not_in_dispatch_center',
    unit,
    unitId: normalized,
    dispatchCenterId: runtime.dispatchCenterId || null,
  };
}

'''
cad = cad.replace(marker, helper + marker, 1)
cad_path.write_text(cad)

manager_path = Path('src/services/aiDispatcherRuntimeManager.js')
manager = manager_path.read_text()
manager = replace_once(
    manager,
    "import { CORE_AI_DISPATCHER_CAD_SCOPES, validateDispatcherCadIntegration } from './cadService.js';",
    "import { CORE_AI_DISPATCHER_CAD_SCOPES, checkUnitInCurrentDispatchCenter, validateDispatcherCadIntegration } from './cadService.js';",
    'runtime manager CAD import',
)
marker = """        this.log('CAD_PREFLIGHT_OK', {
          id: profile.id,
          dispatchCenterId: cadPreflight.dispatchCenterId,
          activeCallCount: cadPreflight.activeCallCount,
          scopes: cadPreflight.scopes,
        });

        const dispatcher = new AIDispatcher({
"""
replacement = """        this.log('CAD_PREFLIGHT_OK', {
          id: profile.id,
          dispatchCenterId: cadPreflight.dispatchCenterId,
          activeCallCount: cadPreflight.activeCallCount,
          scopes: cadPreflight.scopes,
        });

        const unitAccessCache = new Map();
        const unitAccessGuard = async (unitId) => {
          const key = String(unitId || '').trim().toUpperCase().replace(/\\s+/g, '-');
          if (!key) return false;
          const now = Date.now();
          const cached = unitAccessCache.get(key);
          if (cached && cached.expiresAt > now) return cached.allowed;

          const decision = await checkUnitInCurrentDispatchCenter(key);
          const allowed = decision?.allowed === true;
          unitAccessCache.set(key, {
            allowed,
            expiresAt: now + (allowed ? 30000 : 5000),
          });
          if (!allowed) {
            this.log('UNIT_CENTER_ACCESS_BLOCKED', {
              profileId: profile.id,
              unitId: key,
              dispatchCenterId: profile.dispatch_center_id,
              reason: decision?.reason || 'unknown',
              error: decision?.error || null,
            });
          }
          return allowed;
        };

        const dispatcher = new AIDispatcher({
"""
manager = replace_once(manager, marker, replacement, 'insert unit center guard')
manager = replace_once(
    manager,
    "          runtimeContext: context,\n        });",
    "          runtimeContext: context,\n          unitAccessGuard,\n        });",
    'pass unit access guard',
)
manager = replace_once(
    manager,
    "        if (dispatcher.displayChannel) adapter.setActiveChannel(dispatcher.displayChannel);",
    "        if (!dispatcher.profileManaged && dispatcher.displayChannel) adapter.setActiveChannel(dispatcher.displayChannel);",
    'managed signaling bare alias',
)
manager = replace_once(
    manager,
    "        const allowed = async (data) => dispatcher.matchesChannel(data.channelId);",
    "        const allowed = async (data) => {\n          if (!dispatcher.matchesChannel(data.channelId)) return false;\n          return unitAccessGuard(data.unitId);\n        };",
    'signaling unit center guard',
)
manager_path.write_text(manager)

test_path = Path('src/services/__tests__/strictCenterIsolation.test.js')
test_path.write_text(r'''import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pool from '../../db/index.js';
import { AIDispatcher } from '../aiDispatchService.js';
import { checkUnitInCurrentDispatchCenter } from '../cadService.js';
import { runWithRuntime } from '../runtimeContext.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('strict AI dispatch-center isolation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts only a unit returned by the selected dispatch center', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      units: [{ unit_id: 'SEC-2301', status: 'available' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = {
      runtimeId: 'security-ai',
      managed: true,
      dispatchCenterId: 'center-security',
      cadUrl: 'https://cad.example.test',
      cadApiKey: 'secret',
    };

    const local = await runWithRuntime(runtime, () => checkUnitInCurrentDispatchCenter('SEC-2301'));
    const external = await runWithRuntime(runtime, () => checkUnitInCurrentDispatchCenter('INDIANA-1'));

    expect(local.allowed).toBe(true);
    expect(external).toMatchObject({
      allowed: false,
      reason: 'unit_not_in_dispatch_center',
      dispatchCenterId: 'center-security',
    });
    for (const [url, options] of fetchMock.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('dispatch_center_id')).toBe('center-security');
      expect(options.headers['X-Dispatch-Center-Id']).toBe('center-security');
    }
  });

  it('fails closed when CAD unit membership cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'insufficient_scope' }, 403)));
    const result = await runWithRuntime({
      runtimeId: 'security-ai',
      managed: true,
      dispatchCenterId: 'center-security',
      cadUrl: 'https://cad.example.test',
      cadApiKey: 'secret',
    }, () => checkUnitInCurrentDispatchCenter('SEC-2301'));

    expect(result).toMatchObject({
      allowed: false,
      reason: 'cad_unit_read_failed',
      statusCode: 403,
    });
  });

  it('uses only the canonical room key and numeric channel for managed profiles', async () => {
    vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{ id: 77, name: 'OPS1', room_key: 'SECURITY__OPS1' }],
    });
    const dispatcher = new AIDispatcher({
      profileManaged: true,
      runtimeContext: { managed: true, runtimeId: 'security-ai' },
    });

    await dispatcher._resolveChannelAliases('OPS1', 'SECURITY__OPS1');

    expect(dispatcher.channelAliases.has('SECURITY__OPS1')).toBe(true);
    expect(dispatcher.channelAliases.has('77')).toBe(true);
    expect(dispatcher.channelAliases.has('OPS1')).toBe(false);
    expect(dispatcher.matchesChannel('OPS1')).toBe(false);
    expect(dispatcher.matchesChannel('SECURITY__OPS1')).toBe(true);
  });

  it('wires the supplied unit access guard into the audio boundary', () => {
    const guard = vi.fn().mockResolvedValue(true);
    const dispatcher = new AIDispatcher({ unitAccessGuard: guard });
    expect(dispatcher.unitAccessGuard).toBe(guard);
  });
});
''')
