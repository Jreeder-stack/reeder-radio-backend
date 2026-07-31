import { createRuntimeScopedMap } from './runtimeContext.js';

const DEFAULT_WINDOW_MS = 120000;

function getWindowMs() {
  const raw = parseInt(process.env.AI_DISREGARD_WINDOW_MS || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_WINDOW_MS;
}

const TYPE_QUALIFIERS = {
  STATUS_CHANGE: ['status', 'arrival', 'arrived', 'on scene', '10-97', 'en route', '10-76', 'in service', '10-8', 'out of service', '10-7', 'off duty', 'on duty', 'available', 'traffic stop', '10-38'],
  STATUS_CHANGE_OTHER: ['status', 'arrival', 'arrived', 'available', 'on scene', 'unit'],
  ZONE_CHANGE: ['zone', 'sector', 'area'],
  DETAIL: ['detail'],
  ASSIGN_CALL: ['call', 'attach', 'attachment', 'assignment', 'add me'],
  ASSIGN_OTHER_UNIT: ['call', 'attach', 'unit', 'assignment'],
  ADD_NOTE: ['note', 'comment', 'remark'],
  CREATE_CALL: ['call', 'creation', 'created', 'new call'],
  CLEAR_UNIT: ['clear', 'clearance', '10-98'],
  UPDATE_CALL: ['priority', 'update', 'change', 'edit', 'call info', 'detail', 'details'],
};

const unitLogs = createRuntimeScopedMap();

const RETENTION_MULTIPLIER = 4;

function pruneUnit(unitId) {
  const cutoff = Date.now() - getWindowMs() * RETENTION_MULTIPLIER;
  const list = unitLogs.get(unitId);
  if (!list) return;
  while (list.length > 0 && list[0].timestamp < cutoff) list.shift();
  if (list.length === 0) unitLogs.delete(unitId);
}

let _seq = 0;
function nextId() { return `act-${Date.now().toString(36)}-${(++_seq).toString(36)}`; }

export function recordAction(unitId, type, payload = {}) {
  if (!unitId || !type) return null;
  if (!TYPE_QUALIFIERS[type]) {
    console.warn(`[ActionLog] Unknown action type: ${type}`);
  }
  const action = {
    id: nextId(),
    unitId,
    type,
    timestamp: Date.now(),
    qualifierKeywords: TYPE_QUALIFIERS[type] || [],
    ...payload,
  };
  if (!unitLogs.has(unitId)) unitLogs.set(unitId, []);
  unitLogs.get(unitId).push(action);
  pruneUnit(unitId);
  console.log(`[ActionLog] ${unitId} recorded ${type} id=${action.id}`);
  return action;
}

export function findMostRecentAction(unitId, qualifier = null) {
  pruneUnit(unitId);
  const list = unitLogs.get(unitId) || [];
  if (list.length === 0) return null;
  if (!qualifier) return list[list.length - 1];
  const q = String(qualifier).toLowerCase().trim();
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (a.qualifierKeywords.some(k => q.includes(k))) return a;
  }
  return null;
}

export function removeAction(unitId, actionId) {
  const list = unitLogs.get(unitId);
  if (!list) return;
  const idx = list.findIndex(a => a.id === actionId);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) unitLogs.delete(unitId);
}

export function getActionsForUnit(unitId) {
  pruneUnit(unitId);
  return [...(unitLogs.get(unitId) || [])];
}

export function clearUnitActions(unitId) {
  unitLogs.delete(unitId);
}

export function _resetForTests() {
  unitLogs.clear();
}

export const DISREGARD_WINDOW_MS = getWindowMs();
