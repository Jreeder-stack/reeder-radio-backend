import { speechToText } from '../services/azureSpeechService.js';
import { opusCodec } from '../services/opusCodec.js';
import { ensureV3CorrelationId } from './correlation.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

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

  startTransmission({ unitId, channelId, correlationId } = {}) {
    const unit = clean(unitId);
    if (!unit) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'PTT sender unit is required');
    if (String(channelId) !== String(this.runtimeContext.channelId) && String(channelId) !== String(this.runtimeContext.roomKey)) {
      throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT, 'PTT channel does not belong to this V3 runtime', { statusCode: 409 });
    }
    const id = ensureV3CorrelationId(correlationId, this.runtimeContext.runtimeId);
    this.sessions.set(unit, { unitId: unit, correlationId: id, chunks: [], bytes: 0, startedAt: Date.now(), dropped: false });
    this._diag('ptt_started', id, true, { unitId: unit });
    return id;
  }

  pushFrame({ unitId, opusPayload, codec = 'opus' } = {}) {
    const unit = clean(unitId);
    const session = this.sessions.get(unit);
    if (!session || !Buffer.isBuffer(opusPayload) || opusPayload.length === 0) return false;
    let pcm;
    try {
      pcm = codec === 'pcm' ? Buffer.from(opusPayload) : this.codec.decodeOpusToPcm(opusPayload, unit);
    } catch (error) {
      this._diag('audio_decode_failed', session.correlationId, false, { unitId: unit, message: error.message });
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

  async endTransmission({ unitId } = {}) {
    const unit = clean(unitId);
    const session = this.sessions.get(unit);
    if (!session) return null;
    this.sessions.delete(unit);
    this.codec.releaseSenderDecoder?.(unit);
    const pcm = Buffer.concat(session.chunks);
    if (pcm.length === 0) {
      this._diag('ptt_empty', session.correlationId, false, { unitId: unit });
      return { unitId: unit, correlationId: session.correlationId, transcript: '', audioBytes: 0 };
    }
    const started = Date.now();
    try {
      const transcript = String(await this.transcribe(pcm) || '').trim();
      this._diag('stt_completed', session.correlationId, true, { unitId: unit, transcript, audioBytes: pcm.length, truncated: session.dropped }, Date.now() - started);
      return { unitId: unit, correlationId: session.correlationId, transcript, audioBytes: pcm.length, truncated: session.dropped };
    } catch (error) {
      this._diag('stt_failed', session.correlationId, false, { unitId: unit, message: error.message }, Date.now() - started);
      throw error;
    }
  }

  cancelTransmission(unitId) {
    const unit = clean(unitId);
    this.sessions.delete(unit);
    this.codec.releaseSenderDecoder?.(unit);
  }

  clear() {
    for (const unitId of this.sessions.keys()) this.codec.releaseSenderDecoder?.(unitId);
    this.sessions.clear();
  }

  _diag(phase, correlationId, success, details, latencyMs = null) {
    this.diagnostics?.record?.({
      phase,
      correlationId,
      runtimeId: this.runtimeContext.runtimeId,
      dispatchCenterId: this.runtimeContext.dispatchCenterId,
      channelId: this.runtimeContext.channelId,
      success,
      latencyMs,
      details,
    });
  }
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
