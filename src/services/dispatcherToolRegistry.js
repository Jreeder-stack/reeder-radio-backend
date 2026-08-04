const STATUS_VALUES = [
  'on_duty',
  'available',
  'en_route',
  'on_scene',
  'off_duty',
  'out_of_service',
];

const CALL_REFERENCE_VALUES = [
  'current',
  'recent',
  'last_created',
  'sole_active',
];

const TOOL_DEFINITIONS = [
  {
    name: 'radio_check',
    description: 'Confirm how a field unit radio transmission is being received.',
    risk: 'none',
    confirmationRequired: false,
    required: [],
    properties: {},
  },
  {
    name: 'time_check',
    description: 'Read the current dispatcher time from the server clock.',
    risk: 'none',
    confirmationRequired: false,
    required: [],
    properties: {},
  },
  {
    name: 'update_unit_status',
    description: 'Change the speaking unit or another identified unit status.',
    risk: 'routine_write',
    confirmationRequired: false,
    required: ['unitId', 'status'],
    properties: {
      unitId: { type: 'string', description: 'Target unit callsign.' },
      status: { type: 'string', enum: STATUS_VALUES },
      callNumber: { type: 'string' },
      callNature: { type: 'string' },
      callLocation: { type: 'string' },
      callCity: { type: 'string' },
    },
  },
  {
    name: 'create_call',
    description: 'Create a CAD call from the incident nature and location. The executor verifies the address and asks for confirmation when required.',
    risk: 'routine_write',
    confirmationRequired: true,
    required: ['nature', 'address'],
    properties: {
      nature: { type: 'string' },
      address: { type: 'string' },
      priority: { type: 'string' },
      additionalUnits: { type: 'array' },
    },
  },
  {
    name: 'assign_unit_to_call',
    description: 'Assign any identified unit to an active CAD call. Resolve conversational references using current CAD calls and recent successful actions.',
    risk: 'routine_write',
    confirmationRequired: false,
    required: ['unitId'],
    anyOf: [['callNumber'], ['callReference'], ['callNature'], ['callLocation']],
    properties: {
      unitId: { type: 'string', description: 'Unit being added, which may differ from the speaking unit.' },
      callNumber: { type: 'string' },
      callReference: { type: 'string', enum: CALL_REFERENCE_VALUES },
      callNature: { type: 'string' },
      callLocation: { type: 'string' },
      callCity: { type: 'string' },
    },
  },
  {
    name: 'add_call_note',
    description: 'Add a routine note to the current, recent, or specified call.',
    risk: 'routine_write',
    confirmationRequired: false,
    required: ['note'],
    properties: {
      note: { type: 'string' },
      callNumber: { type: 'string' },
      callReference: { type: 'string', enum: CALL_REFERENCE_VALUES },
      callNature: { type: 'string' },
      callLocation: { type: 'string' },
      beAdvised: { type: 'boolean' },
    },
  },
  {
    name: 'run_plate',
    description: 'Run a vehicle registration or license plate inquiry.',
    risk: 'sensitive_query',
    confirmationRequired: false,
    required: ['plate'],
    properties: {
      plate: { type: 'string' },
      state: { type: 'string' },
    },
  },
  {
    name: 'run_person',
    description: 'Run a person inquiry using a name, date of birth, driver license, or SSN supplied by the unit.',
    risk: 'sensitive_query',
    confirmationRequired: true,
    required: [],
    anyOf: [['lastName'], ['driverLicense'], ['ssn']],
    properties: {
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      dateOfBirth: { type: 'string' },
      driverLicense: { type: 'string' },
      state: { type: 'string' },
      ssn: { type: 'string' },
    },
  },
  {
    name: 'query_pending_calls',
    description: 'Read active, pending, or unassigned CAD calls visible to this dispatcher.',
    risk: 'read_only',
    confirmationRequired: false,
    required: [],
    properties: {
      nature: { type: 'string' },
      location: { type: 'string' },
      status: { type: 'string' },
    },
  },
  {
    name: 'get_unit_assignment',
    description: 'Read the current CAD call assignment for a unit.',
    risk: 'read_only',
    confirmationRequired: false,
    required: ['unitId'],
    properties: { unitId: { type: 'string' } },
  },
  {
    name: 'get_call_details',
    description: 'Read details for a call identified by number, recent context, nature, or location.',
    risk: 'read_only',
    confirmationRequired: false,
    required: [],
    anyOf: [['callNumber'], ['callReference'], ['callNature'], ['callLocation']],
    properties: {
      callNumber: { type: 'string' },
      callReference: { type: 'string', enum: CALL_REFERENCE_VALUES },
      callNature: { type: 'string' },
      callLocation: { type: 'string' },
      detailField: { type: 'string' },
    },
  },
  {
    name: 'clear_unit',
    description: 'Clear a unit from its current call without closing the call.',
    risk: 'routine_write',
    confirmationRequired: false,
    required: ['unitId'],
    properties: { unitId: { type: 'string' } },
  },
  {
    name: 'close_call',
    description: 'Close a CAD call with a disposition after the guarded confirmation flow.',
    risk: 'high_impact_write',
    confirmationRequired: true,
    required: ['disposition'],
    anyOf: [['callNumber'], ['callReference'], ['callNature'], ['callLocation']],
    properties: {
      callNumber: { type: 'string' },
      callReference: { type: 'string', enum: CALL_REFERENCE_VALUES },
      callNature: { type: 'string' },
      callLocation: { type: 'string' },
      disposition: { type: 'string' },
    },
  },
  {
    name: 'cancel_call',
    description: 'Cancel or void a CAD call after the guarded confirmation flow.',
    risk: 'high_impact_write',
    confirmationRequired: true,
    required: [],
    anyOf: [['callNumber'], ['callReference'], ['callNature'], ['callLocation']],
    properties: {
      callNumber: { type: 'string' },
      callReference: { type: 'string', enum: CALL_REFERENCE_VALUES },
      callNature: { type: 'string' },
      callLocation: { type: 'string' },
      reason: { type: 'string' },
    },
  },
  {
    name: 'request_backup',
    description: 'Request routine additional units for the speaking or identified unit. Protected emergency traffic is handled outside this planner.',
    risk: 'routine_write',
    confirmationRequired: false,
    required: ['unitId'],
    properties: {
      unitId: { type: 'string' },
      location: { type: 'string' },
      reason: { type: 'string' },
    },
  },
].map(definition => Object.freeze({ ...definition }));

const TOOL_MAP = new Map(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));

function cleanString(value, maxLength = 300) {
  if (typeof value !== 'string') return value;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned.slice(0, maxLength);
}

function cleanArguments(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const cleaned = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'string') cleaned[key] = cleanString(value);
    else if (Array.isArray(value)) cleaned[key] = value.slice(0, 12).map(item => cleanString(item, 80)).filter(Boolean);
    else if (typeof value === 'number' || typeof value === 'boolean') cleaned[key] = value;
  }
  if (cleaned.unitId) cleaned.unitId = String(cleaned.unitId).toUpperCase().replace(/\s+/g, '-');
  if (cleaned.plate) cleaned.plate = String(cleaned.plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.state) cleaned.state = String(cleaned.state).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  if (cleaned.status) cleaned.status = String(cleaned.status).toLowerCase().replace(/[\s-]+/g, '_');
  if (cleaned.callReference) cleaned.callReference = String(cleaned.callReference).toLowerCase().replace(/[\s-]+/g, '_');
  return cleaned;
}

export function getDispatcherTool(name) {
  return TOOL_MAP.get(String(name || '').trim()) || null;
}

export function listDispatcherTools() {
  return TOOL_DEFINITIONS.map(tool => ({ ...tool }));
}

export function getPlannerToolCatalog() {
  return TOOL_DEFINITIONS.map(({ name, description, risk, confirmationRequired, required, anyOf, properties }) => ({
    name,
    description,
    risk,
    confirmationRequired,
    required,
    ...(anyOf ? { anyOf } : {}),
    properties,
  }));
}

export function validateDispatcherToolArguments(toolName, args, missingFields = []) {
  const tool = getDispatcherTool(toolName);
  if (!tool) return { valid: false, error: 'unknown_tool', arguments: {}, missingFields: [] };

  const cleaned = cleanArguments(args);
  const declaredMissing = Array.isArray(missingFields)
    ? missingFields.map(item => String(item || '').trim()).filter(Boolean)
    : [];

  const missing = new Set(declaredMissing);
  for (const field of tool.required || []) {
    if (cleaned[field] === undefined || cleaned[field] === '') missing.add(field);
  }

  if (tool.anyOf?.length) {
    const satisfiesAny = tool.anyOf.some(group => group.every(field => cleaned[field] !== undefined && cleaned[field] !== ''));
    if (!satisfiesAny) {
      for (const field of tool.anyOf[0]) missing.add(field);
    }
  }

  for (const [field, schema] of Object.entries(tool.properties || {})) {
    if (!schema?.enum || cleaned[field] === undefined) continue;
    if (!schema.enum.includes(cleaned[field])) {
      return {
        valid: false,
        error: `invalid_${field}`,
        arguments: cleaned,
        missingFields: [...missing],
      };
    }
  }

  return {
    valid: missing.size === 0,
    error: missing.size ? 'missing_required_fields' : null,
    arguments: cleaned,
    missingFields: [...missing],
    tool,
  };
}

export { STATUS_VALUES, CALL_REFERENCE_VALUES };
