export {
  DispatcherV3Error,
  V3_ERROR_CODES,
  asDispatcherV3Error,
} from './errors.js';

export {
  DISPATCHER_V3_RUNTIME_VERSION,
  normalizeV3RuntimeContext,
  validateV3RuntimeContext,
  buildV3RuntimeContext,
  assertV3ContextMatches,
  hasV3Scope,
  requireV3Scopes,
  normalizeScopes,
} from './runtimeContract.js';

export {
  runWithV3Runtime,
  bindV3Runtime,
  getV3RuntimeContext,
  assertCurrentV3Runtime,
} from './runtimeStore.js';

export {
  createV3CorrelationId,
  ensureV3CorrelationId,
  childV3CorrelationId,
} from './correlation.js';

export {
  CommandLinkGateway,
  createCommandLinkGateway,
} from './cadGateway.js';

export { UnitIdentityService } from './unitIdentity.js';

export {
  V3_ACTIONS,
  V3_UNIT_STATUSES,
  getV3ActionDefinition,
  listV3Actions,
  validateV3ActionRequest,
} from './actionContracts.js';

export {
  DISPATCHER_RUNTIME,
  getConfiguredDispatcherRuntime,
  isDispatcherV3Selected,
} from './runtimeSelector.js';
