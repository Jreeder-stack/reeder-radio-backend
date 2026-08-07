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
  V3DiagnosticsJournal,
  recordV3Diagnostic,
} from './diagnostics.js';

export {
  CommandLinkGateway,
  createCommandLinkGateway,
} from './cadGateway.js';

export { UnitIdentityService } from './unitIdentity.js';
export { V3OperationalContextService, sanitizeV3OperationalContext } from './operationalContext.js';
export { V3OperationalAlertService } from './operationalAlertService.js';

export {
  V3_ACTIONS,
  V3_UNIT_STATUSES,
  getV3ActionDefinition,
  listV3Actions,
  validateV3ActionRequest,
} from './actionContracts.js';

export { V3ActionExecutor } from './actionExecutor.js';
export { createDefaultV3ActionHandlers } from './defaultActionHandlers.js';
export { V3SpeechPipeline } from './speechPipeline.js';
export { V3IntentPlanner, isV3PlannerConfigured } from './intentPlanner.js';
export { V3ConversationGate } from './conversationGate.js';
export { materializeV3Plan } from './planMaterializer.js';
export { composeV3Response } from './responseComposer.js';
export { V3LiveDispatcher } from './liveRuntime.js';
