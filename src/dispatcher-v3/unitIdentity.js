import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { ensureV3CorrelationId } from './correlation.js';
import { requireV3Scopes } from './runtimeContract.js';

export class UnitIdentityService {
  constructor({ gateway, context }) {
    if (!gateway) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT, 'UnitIdentityService requires a Command Link gateway');
    if (!context) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT, 'UnitIdentityService requires a V3 runtime context');
    this.gateway = gateway;
    this.context = context;
  }

  async resolve(unitRef, options = {}) {
    const requested = String(unitRef ?? '').trim();
    if (!requested) {
      throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'A unit callsign or unit ID is required');
    }

    requireV3Scopes(this.context, ['unit.read']);
    const correlationId = ensureV3CorrelationId(options.correlationId, this.context.runtimeId);

    let body;
    try {
      body = await this.gateway.get('/api/radio/unit/resolve-v3', {
        query: { unit_ref: requested },
        correlationId,
      });
    } catch (error) {
      const remoteCode = error?.details?.body?.error || error?.details?.body?.code;
      if (remoteCode === 'UNIT_NOT_FOUND') {
        throw new DispatcherV3Error(V3_ERROR_CODES.UNIT_NOT_FOUND, `Unit ${requested} was not found in this dispatch center`, {
          statusCode: 404,
          details: { unitRef: requested, correlationId },
        });
      }
      if (remoteCode === 'UNIT_AMBIGUOUS') {
        throw new DispatcherV3Error(V3_ERROR_CODES.UNIT_AMBIGUOUS, `Unit ${requested} is ambiguous in this dispatch center`, {
          statusCode: 409,
          details: { unitRef: requested, correlationId, candidates: error?.details?.body?.candidates || [] },
        });
      }
      throw error;
    }

    const unit = body?.unit;
    if (!body?.success || !unit?.id || !unit?.unit_number) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, 'Command Link returned an invalid unit identity response', {
        details: { correlationId },
      });
    }

    return Object.freeze({
      unitId: String(unit.id),
      callsign: String(unit.unit_number),
      agencyId: unit.agency_id ? String(unit.agency_id) : null,
      agencyCode: unit.agency_code ? String(unit.agency_code) : null,
      status: unit.status ? String(unit.status) : null,
      dispatchCenterId: this.context.dispatchCenterId,
      correlationId,
    });
  }
}
