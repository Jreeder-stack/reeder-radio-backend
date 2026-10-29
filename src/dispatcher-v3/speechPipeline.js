import { speechToText } from '../services/azureSpeechService.js';
import { opusCodec } from '../services/opusCodec.js';
import { ensureV3CorrelationId } from './correlation.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { isV3TurnIdentity } from './turnEnvelope.js';
import { withV3Stage, V3_DEADLINES } from './operationDeadline.js';

const DEFAULT_MAX_PCM_BYTES = 16000 * 2 * 90;

export class V3SpeechPipeline {
  constructor({ runtimeContext, transcribe = speechToText, codec = opusCodec, diagnostics = null, maxPcmBytes = DEFAULT_MAX_PCM_BYTES } = {}) {
    if (!runtimeContext) throw new TypeError('runtimeContext is required');
    this.runtimeContext = runtimeContext;
    this.transcribe = transcribe;
    this.codec = codec;
    this.diagnostics = diagnostics;
    this.maxPcmBytes = maxPcmBytes;
    this.sessions = new Map();
  }

  startTransmission({ unitId, channelId, correlationId, turnIdentity = null } = {}) {
    const unit = clean(unitId);
    if (!unit) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'PTT sender unit is required');
    if (String(channelId) !== String(this.runtimeContext.channelId) && String(channelId) !== String(this.runtimeContext.roomKey)) {
      throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT, 'PTT channel does not belong to this V3 runtime', { statusCode: 409 });
    }
    const id = ensureV3CorrelationId(correlationId, this.runtimeContext.runtimeId);
    if (turnIdentity && !isV3TurnIdentity(turnIdentity)) throw new TypeError('Trusted turn identity required');
    const key = turnIdentity?.transmissionId || unit;
    if (this.sessions.has(key)) return null;
    const startedAt = turnIdentity?.captureStartedAt ?? Date.now();
    this.sessions.set(key, { unitId: unit, correlationId: id, turnIdentity, chunks: [], bytes: 0, startedAt, dropped: false });
    this._diag('ptt_started', id, true, { unitId: unit }, null, turnIdentity);
    return id;
  }

  pushFrame({ unitId, opusPayload, codec = 'opus' } = {}) {
    const unit = clean(unitId);
    const candidates = [...this.sessions.values()].filter((item) => item.unitId === unit);
    // Legacy audio packets carry a callsign, not a connection/transmission ID.
    // Never choose an arbitrary owner while captures with that callsign overlap.
    if (candidates.length !== 1) return false;
    const session = candidates[0];
    if (!session || !Buffer.isBuffer(opusPayload) || opusPayload.length === 0) return false;
    let pcm;
    try {
      pcm = codec === 'pcm' ? Buffer.from(opusPayload) : this.codec.decodeOpusToPcm(opusPayload, unit);
    } catch (error) {
      this._diag('audio_decode_failed', session.correlationId, false, { unitId: unit, message: error.message }, null, session.turnIdentity);
      return false;
    }
    if (session.bytes + pcm.length > this.maxPcmBytes) {
      session.dropped = true;
      return false;
    }
    session.chunks.push(pcm);
    session.bytes += pcm.length;
    return true;
  }

  sealCapture({ unitId, transmissionId = null } = {}) {
    const unit = clean(unitId);
    const key = transmissionId || unit;
    const session = this.sessions.get(key);
    if (!session || session.unitId !== unit) return null;
    this.sessions.delete(key);
    if (![...this.sessions.values()].some((item) => item.unitId === unit)) this.codec.releaseSenderDecoder?.(unit);
    return session;
  }

  async endTransmission({ unitId, transmissionId = null, capture = null, turnEnvelope = null } = {}) {
    const unit = clean(unitId);
    const session = capture || this.sealCapture({ unitId: unit, transmissionId });
    if (!session) return null;
    if (session.unitId !== unit || (session.turnIdentity && turnEnvelope?.identity !== session.turnIdentity)) {
      throw new DispatcherV3Error(V3_ERROR_CODES.UNAUTHORIZED, 'Speech capture does not belong to this turn');
    }
    const result = {
      unitId: turnEnvelope?.speaker?.callsign || unit,
      correlationId: session.correlationId,
      captureStartedAt: session.startedAt,
      captureEndedAt: turnEnvelope?.captureEndedAt ?? Date.now(),
      turnEnvelope,
    };
    const pcm = Buffer.concat(session.chunks);
    if (pcm.length === 0) {
      this._diag('ptt_empty', session.correlationId, false, { unitId: unit }, null, session.turnIdentity, turnEnvelope);
      return { ...result, transcript: '', audioBytes: 0 };
    }
    const started = Date.now();
    try {
      const transcript = String(await withV3Stage('transcription', V3_DEADLINES.transcriptionMs,
        ({ signal, timeoutMs }) => this.transcribe(pcm, { turnEnvelope, signal, timeoutMs })) || '').trim();
      this._diag('stt_completed', session.correlationId, true, { unitId: unit, transcript, audioBytes: pcm.length, truncated: session.dropped }, Date.now() - started, session.turnIdentity, turnEnvelope);
      return { ...result, transcript, audioBytes: pcm.length, truncated: session.dropped };
    } catch (error) {
      this._diag('stt_failed', session.correlationId, false, { unitId: unit, message: error.message }, Date.now() - started, session.turnIdentity, turnEnvelope);
      throw error;
    }
  }

  cancelTransmission(unitId, transmissionId = null) {
    const unit = clean(unitId);
    this.sessions.delete(transmissionId || unit);
    if (![...this.sessions.values()].some((item) => item.unitId === unit)) this.codec.releaseSenderDecoder?.(unit);
  }

  clear() {
    for (const unitId of new Set([...this.sessions.values()].map((item) => item.unitId))) this.codec.releaseSenderDecoder?.(unitId);
    this.sessions.clear();
  }

  _diag(phase, correlationId, success, details, latencyMs = null, turnIdentity = null, turnEnvelope = null) {
    this.diagnostics?.record?.({
      phase,
      correlationId,
      runtimeId: this.runtimeContext.runtimeId,
      dispatchCenterId: this.runtimeContext.dispatchCenterId,
      channelId: this.runtimeContext.channelId,
      success,
      latencyMs,
      turnIdentity,
      turnEnvelope,
      details,
    });
  }
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
