import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class V3FieldIncidentCoordinator {
  constructor({
    gateway,
    unitIdentityService,
    operationalContextService,
    createCall,
    addCallNote,
    updateCall,
    getUnitLocation = () => null,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
  } = {}) {
    if (!gateway) throw new TypeError('gateway is required');
    if (!unitIdentityService) throw new TypeError('unitIdentityService is required');
    if (!operationalContextService) throw new TypeError('operationalContextService is required');
    if (typeof createCall !== 'function') throw new TypeError('createCall is required');
    if (typeof addCallNote !== 'function') throw new TypeError('addCallNote is required');
    if (typeof updateCall !== 'function') throw new TypeError('updateCall is required');
    this.gateway = gateway;
    this.unitIdentityService = unitIdentityService;
    this.operationalContextService = operationalContextService;
    this.createCall = createCall;
    this.addCallNote = addCallNote;
    this.updateCall = updateCall;
    this.getUnitLocation = getUnitLocation;
    this.now = now;
    this.ttlMs = ttlMs;
    this.incidents = new Map();
  }

  getDialogueContext(unitRef) {
    const key = normalizeUnit(unitRef);
    const state = this.incidents.get(key);
    if (!state) return null;
    if (state.expiresAt < this.now()) {
      this.incidents.delete(key);
      return null;
    }
    return {
      kind: 'field_incident',
      eventType: state.eventType,
      callId: state.callId,
      pendingGoals: [...state.pendingGoals],
      originalNote: state.originalNote,
    };
  }

  clear(unitRef) {
    this.incidents.delete(normalizeUnit(unitRef));
  }

  clearAll() {
    this.incidents.clear();
  }

  async report({ input, correlationId }) {
    const identity = await this.unitIdentityService.resolve(input.unitId, { correlationId });
    const context = await this.operationalContextService.snapshot({ speakerCallsign: identity.callsign, correlationId });
    const state = {
      key: normalizeUnit(identity.callsign),
      callsign: identity.callsign,
      unitId: identity.unitId,
      eventType: input.eventType,
      originalNote: input.note,
      callId: context.currentCall?.id || null,
      call: context.currentCall || null,
      noteRecorded: false,
      pendingGoals: initialGoals(input),
      deferredNotes: [],
      partialErrors: [],
      expiresAt: this.now() + this.ttlMs,
    };

    if (!state.callId) {
      let gps = null;
      try {
        gps = await Promise.resolve(this.getUnitLocation(identity.callsign));
      } catch (error) {
        state.partialErrors.push(errorResult(error, 'unit_location'));
      }
      const locationQuery = coordinateQuery(gps) || clean(input.location);
      if (locationQuery) await this._tryCreateCall(state, locationQuery, correlationId);
    }

    await this._tryRecordNote(state, input.note, correlationId);
    if (input.subjectDescription) {
      await this._tryRecordNote(state, `SUBJECT DESCRIPTION: ${input.subjectDescription}`, correlationId);
      removeGoal(state, 'subject_description');
    }

    this._save(state);
    return {
      call: state.call,
      callId: state.callId,
      eventType: state.eventType,
      pendingGoals: [...state.pendingGoals],
      partialErrors: state.partialErrors,
      keepListening: state.pendingGoals.length > 0,
      radioResponse: initialRadioResponse(state),
    };
  }

  async update({ input, correlationId }) {
    const identity = await this.unitIdentityService.resolve(input.unitId, { correlationId });
    let state = this.incidents.get(normalizeUnit(identity.callsign));
    if (state?.expiresAt < this.now()) {
      this.incidents.delete(normalizeUnit(identity.callsign));
      state = null;
    }

    if (!state) {
      const context = await this.operationalContextService.snapshot({ speakerCallsign: identity.callsign, correlationId });
      state = {
        key: normalizeUnit(identity.callsign), callsign: identity.callsign, unitId: identity.unitId,
        eventType: 'operational_update', originalNote: input.note || input.value,
        callId: context.currentCall?.id || null, call: context.currentCall || null,
        noteRecorded: false, pendingGoals: [], deferredNotes: [], partialErrors: [],
        expiresAt: this.now() + this.ttlMs,
      };
    }

    state.partialErrors = [];
    if (input.informationType === 'location') {
      await this._applyLocation(state, input.value, correlationId);
      removeGoal(state, 'location');
    } else {
      const prefix = informationPrefix(input.informationType);
      await this._tryRecordNote(state, input.note || `${prefix}${input.value}`, correlationId);
      if (input.informationType === 'subject_description') removeGoal(state, 'subject_description');
    }

    state.expiresAt = this.now() + this.ttlMs;
    this._save(state);
    const askForDescription = input.informationType === 'location' && state.pendingGoals.includes('subject_description');
    return {
      call: state.call,
      callId: state.callId,
      eventType: state.eventType,
      pendingGoals: [...state.pendingGoals],
      partialErrors: state.partialErrors,
      keepListening: state.pendingGoals.length > 0,
      radioResponse: askForDescription ? `10-4. What's the subject's description?` : '10-4.',
    };
  }

  async _applyLocation(state, query, correlationId) {
    const resolution = await this.gateway.get('/api/radio/locations/resolve', {
      correlationId,
      query: { q: clean(query) },
    });
    const location = canonicalLocation(resolution);
    if (!location.address) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, `Unable to verify incident location: ${query}`, {
        statusCode: 422,
        details: { query, source: resolution?.source || null },
      });
    }

    if (!state.callId) {
      await this._tryCreateCall(state, location.address, correlationId, location);
    } else {
      const updated = await this.updateCall({
        input: {
          callId: state.callId,
          location: location.address,
          city: location.city,
          municipality: location.municipality,
          county: location.county,
          state: location.state,
          zip: location.zip,
          latitude: location.latitude,
          longitude: location.longitude,
          crossStreet1: location.crossStreet1,
          crossStreet2: location.crossStreet2,
        },
        correlationId,
      });
      state.call = updated?.call || state.call;
    }

    const verificationNote = locationVerificationNote(location);
    if (verificationNote) await this._tryRecordNote(state, verificationNote, correlationId);
    await this._flushDeferredNotes(state, correlationId);
  }

  async _tryCreateCall(state, query, correlationId, resolved = null) {
    try {
      const created = await this.createCall({
        input: {
          type: natureForEvent(state.eventType),
          location: query,
          city: resolved?.city || null,
          municipality: resolved?.municipality || null,
          county: resolved?.county || null,
          state: resolved?.state || null,
          zip: resolved?.zip || null,
          latitude: resolved?.latitude || null,
          longitude: resolved?.longitude || null,
          crossStreet1: resolved?.crossStreet1 || null,
          crossStreet2: resolved?.crossStreet2 || null,
          priority: 'high',
          description: state.originalNote,
          unitIds: [state.unitId],
        },
        correlationId,
      });
      state.call = created?.call || created?.data?.call || null;
      state.callId = callId(state.call) || callId(created);
      await this._flushDeferredNotes(state, correlationId);
    } catch (error) {
      state.partialErrors.push(errorResult(error, 'create_call'));
    }
  }

  async _tryRecordNote(state, note, correlationId) {
    const text = clean(note);
    if (!text) return;
    if (!state.callId) {
      state.deferredNotes.push(text);
      return;
    }
    try {
      const result = await this.addCallNote({ input: { callId: state.callId, note: text, unitId: state.unitId }, correlationId });
      state.call = result?.call || state.call;
      if (text === state.originalNote) state.noteRecorded = true;
    } catch (error) {
      state.partialErrors.push(errorResult(error, 'add_note'));
      state.deferredNotes.push(text);
    }
  }

  async _flushDeferredNotes(state, correlationId) {
    if (!state.callId || state.deferredNotes.length === 0) return;
    const pending = [...state.deferredNotes];
    state.deferredNotes = [];
    for (const note of pending) await this._tryRecordNote(state, note, correlationId);
  }

  _save(state) {
    if (state.pendingGoals.length === 0 && state.deferredNotes.length === 0) {
      this.incidents.delete(state.key);
      return;
    }
    this.incidents.set(state.key, state);
  }
}

function initialGoals(input) {
  if (input.eventType === 'operational_update') return [];
  const goals = [];
  if (!clean(input.location) || input.eventType === 'shots_fired') goals.push('location');
  if (!clean(input.subjectDescription)) goals.push('subject_description');
  return goals;
}

function initialRadioResponse(state) {
  if (state.eventType === 'shots_fired') return `10-4, shots fired, what's your location?`;
  if (state.pendingGoals.includes('location')) return `10-4. What's your location?`;
  if (state.pendingGoals.includes('subject_description')) return `10-4. What's the subject's description?`;
  return '10-4.';
}

function natureForEvent(eventType) {
  if (eventType === 'shots_fired') return 'SHOTS FIRED';
  if (eventType === 'operational_update') return 'ASSIST - OFFICER';
  return 'ASSIST - OFFICER';
}

function informationPrefix(type) {
  const labels = {
    subject_description: 'SUBJECT DESCRIPTION: ', direction: 'DIRECTION OF TRAVEL: ',
    weapon: 'WEAPON INFORMATION: ', status: 'STATUS UPDATE: ', other: '',
  };
  return labels[type] ?? '';
}

function canonicalLocation(resolution) {
  const value = resolution?.location || {};
  return {
    address: clean(value.address),
    city: clean(value.city) || clean(value.municipality),
    municipality: clean(value.municipality),
    county: clean(value.county),
    state: clean(value.state),
    zip: clean(value.zipCode || value.zip),
    latitude: clean(value.latitude),
    longitude: clean(value.longitude),
    crossStreet1: clean(value.crossStreet1 || value.cross_street_1),
    crossStreet2: clean(value.crossStreet2 || value.cross_street_2),
  };
}

function locationVerificationNote(location) {
  const place = [location.address, location.municipality || location.city].filter(Boolean).join(', ');
  const crosses = [location.crossStreet1, location.crossStreet2].filter(Boolean).join(' / ');
  if (!place && !crosses) return null;
  return `LOCATION VERIFIED: ${place || 'address unavailable'}${crosses ? `. CROSS STREETS: ${crosses}` : ''}`;
}

function removeGoal(state, goal) {
  state.pendingGoals = state.pendingGoals.filter((item) => item !== goal);
}

function coordinateQuery(location) {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return null;
  return `${location.lat},${location.lng}`;
}

function callId(value) {
  return clean(value?.id || value?.call_id || value?.callId || value?.call?.id || value?.call?.call_id || value?.call?.callId);
}

function errorResult(error, phase) {
  return { phase, code: error?.code || V3_ERROR_CODES.CAD_REJECTED, message: error?.message || 'CAD operation failed' };
}

function normalizeUnit(value) {
  return String(value || '').trim().toUpperCase();
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

export const __fieldIncidentCoordinatorTest = {
  canonicalLocation,
  initialGoals,
  locationVerificationNote,
  natureForEvent,
};
