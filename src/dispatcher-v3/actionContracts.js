import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { requireV3Scopes } from './runtimeContract.js';

export const V3_ACTIONS = Object.freeze({
  RADIO_CHECK: 'RADIO_CHECK',
  TIME_CHECK: 'TIME_CHECK',
  SET_UNIT_STATUS: 'SET_UNIT_STATUS',
  CHANGE_UNIT_ZONE: 'CHANGE_UNIT_ZONE',
  GET_CURRENT_CALL: 'GET_CURRENT_CALL',
  GET_CALL: 'GET_CALL',
  LIST_ACTIVE_CALLS: 'LIST_ACTIVE_CALLS',
  SEARCH_CALLS: 'SEARCH_CALLS',
  CREATE_CALL: 'CREATE_CALL',
  UPDATE_CALL: 'UPDATE_CALL',
  ADD_CALL_NOTE: 'ADD_CALL_NOTE',
  ASSIGN_UNIT: 'ASSIGN_UNIT',
  UNASSIGN_UNIT: 'UNASSIGN_UNIT',
  MAKE_PRIMARY: 'MAKE_PRIMARY',
  UPDATE_ASSIGNMENT_TIMES: 'UPDATE_ASSIGNMENT_TIMES',
  CLEAR_UNIT: 'CLEAR_UNIT',
  CLOSE_CALL: 'CLOSE_CALL',
  STATUS_CHECK: 'STATUS_CHECK',
  REQUEST_BACKUP: 'REQUEST_BACKUP',
  REPORT_FIELD_INCIDENT: 'REPORT_FIELD_INCIDENT',
  UPDATE_FIELD_INCIDENT: 'UPDATE_FIELD_INCIDENT',
  DECLARE_EMERGENCY: 'DECLARE_EMERGENCY',
});

export const V3_UNIT_STATUSES = Object.freeze([
  'on_duty', 'available', 'en_route', 'on_scene', 'busy', 'off_duty',
  'not_available', 'out_of_service', 'training', 'unavailable', 'special_duty',
  'court', 'out_of_vehicle', 'detail', 'en_route_secondary', 'arrived_secondary', 'on_call',
]);

export const V3_CALL_STATUSES = Object.freeze([
  'pending', 'active', 'assigned', 'en_route', 'on_scene', 'cleared', 'closed', 'cancelled',
]);

const CALL_PRIORITIES = Object.freeze(['high', 'medium', 'low', 'routine']);

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
  [V3_ACTIONS.GET_CALL]: define(['call.read'], (input) => ({
    callId: requiredString(input.callId, 'callId'),
  })),
  [V3_ACTIONS.LIST_ACTIVE_CALLS]: define(['call.read'], validateEmptyOrUnit),
  [V3_ACTIONS.SEARCH_CALLS]: define(['call.read'], (input) => ({
    query: optionalString(input.query),
    callNumber: optionalString(input.callNumber),
    address: optionalString(input.address),
    nature: optionalString(input.nature),
    caller: optionalString(input.caller),
    status: optionalEnum(input.status, 'status', V3_CALL_STATUSES),
    priority: optionalEnum(input.priority, 'priority', CALL_PRIORITIES),
    unitId: optionalString(input.unitId),
    dateFrom: optionalString(input.dateFrom),
    dateTo: optionalString(input.dateTo),
  })),
  [V3_ACTIONS.CREATE_CALL]: define(['call.write'], (input) => ({
    type: requiredString(input.type, 'type'),
    location: requiredString(input.location, 'location'),
    apt: optionalString(input.apt),
    city: optionalString(input.city),
    state: optionalString(input.state),
    zip: optionalString(input.zip),
    county: optionalString(input.county),
    municipality: optionalString(input.municipality),
    priority: optionalEnum(input.priority, 'priority', CALL_PRIORITIES),
    description: optionalString(input.description),
    callerName: optionalString(input.callerName),
    callerPhone: optionalString(input.callerPhone),
    zone: optionalString(input.zone),
    latitude: optionalString(input.latitude),
    longitude: optionalString(input.longitude),
    crossStreet1: optionalString(input.crossStreet1),
    crossStreet2: optionalString(input.crossStreet2),
    locationAddressId: optionalString(input.locationAddressId),
    securityClientId: optionalString(input.securityClientId),
    securityClientSiteId: optionalString(input.securityClientSiteId),
    unitIds: optionalStringArray(input.unitIds, 'unitIds'),
  })),
  [V3_ACTIONS.UPDATE_CALL]: define(['call.write'], (input) => ({
    callId: requiredString(input.callId, 'callId'),
    ...validateCallMutationFields(input),
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
  [V3_ACTIONS.UNASSIGN_UNIT]: define(['call.write'], (input) => ({
    callId: requiredString(input.callId, 'callId'),
    unitId: requiredString(input.unitId, 'unitId'),
  })),
  [V3_ACTIONS.MAKE_PRIMARY]: define(['call.write'], (input) => ({
    callId: requiredString(input.callId, 'callId'),
    unitId: requiredString(input.unitId, 'unitId'),
  })),
  [V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES]: define(['call.write'], (input) => {
    const result = {
      callId: requiredString(input.callId, 'callId'),
      unitId: requiredString(input.unitId, 'unitId'),
      assignedAt: optionalString(input.assignedAt),
      dispatchedAt: optionalString(input.dispatchedAt),
      arrivedAt: optionalString(input.arrivedAt),
      ondtAt: optionalString(input.ondtAt),
    };
    if (![result.assignedAt, result.dispatchedAt, result.arrivedAt, result.ondtAt].some(Boolean)) {
      throw invalidInput('At least one assignment timestamp is required');
    }
    return result;
  }),
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
  [V3_ACTIONS.REPORT_FIELD_INCIDENT]: define(['call.write'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
    eventType: requiredEnum(input.eventType, 'eventType', [
      'shots_fired', 'officer_assist', 'gunpoint', 'taserpoint', 'fight', 'operational_update',
    ]),
    note: requiredString(input.note, 'note'),
    location: optionalString(input.location),
    subjectDescription: optionalString(input.subjectDescription),
  })),
  [V3_ACTIONS.UPDATE_FIELD_INCIDENT]: define(['call.write'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
    informationType: requiredEnum(input.informationType, 'informationType', [
      'location', 'subject_description', 'direction', 'weapon', 'status', 'other',
    ]),
    value: requiredString(input.value, 'value'),
    note: optionalString(input.note),
  })),
  [V3_ACTIONS.DECLARE_EMERGENCY]: define(['unit.write'], (input) => ({
    unitId: requiredString(input.unitId, 'unitId'),
    callId: optionalString(input.callId),
    location: optionalString(input.location),
    reason: optionalString(input.reason),
  })),
});

function validateCallMutationFields(input) {
  return {
    type: optionalString(input.type),
    location: optionalString(input.location),
    apt: optionalString(input.apt),
    city: optionalString(input.city),
    state: optionalString(input.state),
    zip: optionalString(input.zip),
    county: optionalString(input.county),
    municipality: optionalString(input.municipality),
    zone: optionalString(input.zone),
    latitude: optionalString(input.latitude),
    longitude: optionalString(input.longitude),
    crossStreet1: optionalString(input.crossStreet1),
    crossStreet2: optionalString(input.crossStreet2),
    priority: optionalEnum(input.priority, 'priority', CALL_PRIORITIES),
    status: optionalEnum(input.status, 'status', V3_CALL_STATUSES),
    description: optionalString(input.description),
    callerName: optionalString(input.callerName),
    callerPhone: optionalString(input.callerPhone),
    locationAddressId: optionalString(input.locationAddressId),
    securityClientId: optionalString(input.securityClientId),
    securityClientSiteId: optionalString(input.securityClientSiteId),
    disposition: optionalString(input.disposition),
    dispositionNotes: optionalString(input.dispositionNotes),
  };
}

export function getV3ActionDefinition(action) {
  const normalized = String(action || '').trim().toUpperCase();
  return ACTION_DEFINITIONS[normalized] || null;
}

export function listV3Actions() { return Object.keys(ACTION_DEFINITIONS); }

export function validateV3ActionRequest(request = {}, runtimeContext = null) {
  const action = String(request.action || '').trim().toUpperCase();
  const definition = getV3ActionDefinition(action);
  if (!definition) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION, `Unknown Dispatcher V3 action: ${action || '(empty)'}`, { statusCode: 400, details: { action: action || null } });
  if (runtimeContext) requireV3Scopes(runtimeContext, definition.scopes);
  let input;
  try { input = definition.validate(request.input || {}); }
  catch (error) {
    if (error instanceof DispatcherV3Error) throw error;
    throw invalidInput(error?.message || 'Invalid action input');
  }
  return Object.freeze({ action, input: deepFreeze(input), scopes: definition.scopes });
}

function define(scopes, validate) { return Object.freeze({ scopes: Object.freeze([...scopes]), validate }); }
function validateOptionalUnitOnly(input) { return { unitId: optionalString(input.unitId) }; }
function validateEmptyOrUnit(input) { return { unitId: optionalString(input.unitId) }; }
function requiredString(value, field) { const text = optionalString(value); if (!text) throw invalidInput(`${field} is required`, field); return text; }
function optionalString(value) { if (value === undefined || value === null) return null; const text = String(value).trim(); return text || null; }
function requiredEnum(value, field, allowed) { const text = requiredString(value, field).toLowerCase(); if (!allowed.includes(text)) throw invalidInput(`${field} must be one of: ${allowed.join(', ')}`, field); return text; }
function optionalEnum(value, field, allowed) { const text = optionalString(value); if (!text) return null; const normalized = text.toLowerCase(); if (!allowed.includes(normalized)) throw invalidInput(`${field} must be one of: ${allowed.join(', ')}`, field); return normalized; }
function optionalStringArray(value, field) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw invalidInput(`${field} must be an array`, field); const result = value.map((entry) => requiredString(entry, field)); return Object.freeze(Array.from(new Set(result))); }
function invalidInput(message, field = null) { return new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, message, { statusCode: 400, details: field ? { field } : null }); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
