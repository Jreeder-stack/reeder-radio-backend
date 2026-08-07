import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { requireV3Scopes } from './runtimeContract.js';

export const V3_ACTIONS = Object.freeze({
  RADIO_CHECK: 'RADIO_CHECK',
  TIME_CHECK: 'TIME_CHECK',
  SET_UNIT_STATUS: 'SET_UNIT_STATUS',
  CHANGE_UNIT_ZONE: 'CHANGE_UNIT_ZONE',
  GET_CURRENT_CALL: 'GET_CURRENT_CALL',
  CREATE_CALL: 'CREATE_CALL',
  ADD_CALL_NOTE: 'ADD_CALL_NOTE',
  ASSIGN_UNIT: 'ASSIGN_UNIT',
  CLEAR_UNIT: 'CLEAR_UNIT',
  CLOSE_CALL: 'CLOSE_CALL',
  STATUS_CHECK: 'STATUS_CHECK',
  REQUEST_BACKUP: 'REQUEST_BACKUP',
  DECLARE_EMERGENCY: 'DECLARE_EMERGENCY',
});

export const V3_UNIT_STATUSES = Object.freeze([
  'on_duty',
  'available',
  'en_route',
  'on_scene',
  'busy',
  'off_duty',
  'not_available',
  'out_of_service',
  'training',
  'unavailable',
  'special_duty',
  'court',
  'out_of_vehicle',
  'detail',
  'en_route_secondary',
  'arrived_secondary',
  'on_call',
]);

const ACTION_DEFINITIONS = Object.freeze({
  [V3_ACTIONS.RADIO_CHECK]: define([], validateOptionalUnitOnly),
  [V3_ACTIONS.TIME_CHECK]: define([], validateEmptyOrUnit),
  [V3_ACTIONS.SET_UNIT_STATUS]: define(['unit.write'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
    status: requiredEnum(input.status, 'status', V3_UNIT_STATUSES),
    note: optionalString(input.note),
  })),
  [V3_ACTIONS.CHANGE_UNIT_ZONE]: define(['unit.write'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
    zone: requiredString(input.zone, 'zone'),
  })),
  [V3_ACTIONS.GET_CURRENT_CALL]: define(['call.read'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
  })),
  [V3_ACTIONS.CREATE_CALL]: define(['call.write'], (input) => ({
    type: requiredString(input.type, 'type'),
    location: requiredString(input.location, 'location'),
    city: optionalString(input.city),
    municipality: optionalString(input.municipality),
    priority: optionalEnum(input.priority, 'priority', ['high', 'medium', 'low', 'routine']),
    description: optionalString(input.description),
    callerName: optionalString(input.callerName),
    callerPhone: optionalString(input.callerPhone),
    zone: optionalString(input.zone),
    unitIds: requiredStringArray(input.unitIds, 'unitIds', { min: 1 }),
  })),
  [V3_ACTIONS.ADD_CALL_NOTE]: define(['call.write'], (input) => ({
    callId: requiredString(input.callId, 'callId'),
    note: requiredString(input.note, 'note'),
    unitId: optionalString(input.unitId),
  })),
  [V3_ACTIONS.ASSIGN_UNIT]: define(['call.write'], (input) => ({
    callId: requiredString(input.callId, 'callId'),
    unitId: requiredString(input.unitId, 'unitId'),
  })),
  [V3_ACTIONS.CLEAR_UNIT]: define(['call.write'], (input) => ({
    callId: requiredString(input.callId, 'callId'),
    unitId: requiredString(input.unitId, 'unitId'),
    disposition: optionalString(input.disposition),
  })),
  [V3_ACTIONS.CLOSE_CALL]: define(['call.write'], (input) => ({
    callId: requiredString(input.callId, 'callId'),
    disposition: requiredString(input.disposition, 'disposition'),
    unitIds: optionalStringArray(input.unitIds, 'unitIds'),
    note: optionalString(input.note),
  })),
  [V3_ACTIONS.STATUS_CHECK]: define(['unit.read'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
  })),
  [V3_ACTIONS.REQUEST_BACKUP]: define(['call.write'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
    callId: optionalString(input.callId),
    location: optionalString(input.location),
    priority: optionalEnum(input.priority, 'priority', ['routine', 'urgent', 'emergency']),
    reason: optionalString(input.reason),
  })),
  [V3_ACTIONS.DECLARE_EMERGENCY]: define(['unit.write'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
    callId: optionalString(input.callId),
    location: optionalString(input.location),
    reason: optionalString(input.reason),
  })),
});

export function getV3ActionDefinition(action) {
  const normalized = String(action || '').trim().toUpperCase();
  return ACTION_DEFINITIONS[normalized] || null;
}

export function listV3Actions() {
  return Object.keys(ACTION_DEFINITIONS);
}

export function validateV3ActionRequest(request = {}, runtimeContext = null) {
  const action = String(request.action || '').trim().toUpperCase();
  const definition = getV3ActionDefinition(action);
  if (!definition) {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.INVALID_ACTION,
      `Unknown Dispatcher V3 action: ${action || '(empty)'}`,
      { statusCode: 400, details: { action: action || null } },
    );
  }

  if (runtimeContext) requireV3Scopes(runtimeContext, definition.scopes);

  let input;
  try {
    input = definition.validate(request.input || {});
  } catch (error) {
    if (error instanceof DispatcherV3Error) throw error;
    throw invalidInput(error?.message || 'Invalid action input');
  }

  return Object.freeze({ action, input: deepFreeze(input), scopes: definition.scopes });
}

function define(scopes, validate) {
  return Object.freeze({ scopes: Object.freeze([...scopes]), validate });
}

function validateOptionalUnitOnly(input) {
  return { unitId: optionalString(input.unitId) };
}

function validateEmptyOrUnit(input) {
  return { unitId: optionalString(input.unitId) };
}

function requiredString(value, field) {
  const text = optionalString(value);
  if (!text) throw invalidInput(`${field} is required`, field);
  return text;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function requiredEnum(value, field, allowed) {
  const text = requiredString(value, field).toLowerCase();
  if (!allowed.includes(text)) throw invalidInput(`${field} must be one of: ${allowed.join(', ')}`, field);
  return text;
}

function optionalEnum(value, field, allowed) {
  const text = optionalString(value);
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (!allowed.includes(normalized)) throw invalidInput(`${field} must be one of: ${allowed.join(', ')}`, field);
  return normalized;
}

function requiredStringArray(value, field, options = {}) {
  const result = optionalStringArray(value, field);
  if ((options.min || 0) > result.length) throw invalidInput(`${field} requires at least ${options.min} item(s)`, field);
  return result;
}

function optionalStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidInput(`${field} must be an array`, field);
  const result = value.map((entry) => requiredString(entry, field));
  return Object.freeze(Array.from(new Set(result)));
}

function invalidInput(message, field = null) {
  return new DispatcherV3Error(
    V3_ERROR_CODES.INVALID_ACTION_INPUT,
    message,
    { statusCode: 400, details: field ? { field } : null },
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
