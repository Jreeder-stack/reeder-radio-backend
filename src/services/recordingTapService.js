import fs from 'fs';
import path from 'path';
import { opusCodec, SAMPLE_RATE, CHANNELS } from './opusCodec.js';
import { sendAudioMessage } from './messagesService.js';
import { getAudioDataByFilename } from '../db/index.js';

const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');
const TX_IDLE_TIMEOUT_MS = 2000;
const MAX_TX_DURATION_MS = 60000;
const MIN_TX_DURATION_MS = 100;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const CLEANUP_MAX_AGE_MS = 60 * 60 * 1000;

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

const activeTxRecordings = new Map();

function txKey(channelId, unitId) {
  return `${channelId}::${unitId}`;
}

function handleRecordingFrame({ channelId, unitId, sequence, opusPayload, codec, timestamp }) {
  const key = txKey(channelId, unitId);
  let recording = activeTxRecordings.get(key);

  if (!recording) {
    recording = {
      channelId,
      unitId,
      startTime: timestamp,
      lastFrameTime: timestamp,
      frames: [],
      codec: codec || 'opus',
      idleTimer: null,
      maxTimer: null,
    };
    activeTxRecordings.set(key, recording);
    console.log(`[RecordingTap] TX recording started: unit=${unitId} channel=${channelId} codec=${recording.codec}`);

    recording.maxTimer = setTimeout(() => {
      console.log(`[RecordingTap] TX max duration reached: unit=${unitId} channel=${channelId}`);
      finalizeRecording(key);
    }, MAX_TX_DURATION_MS);
    if (recording.maxTimer.unref) recording.maxTimer.unref();
  }

  recording.frames.push(opusPayload);
  recording.lastFrameTime = timestamp;

  if (recording.idleTimer) clearTimeout(recording.idleTimer);
  recording.idleTimer = setTimeout(() => {
    finalizeRecording(key);
  }, TX_IDLE_TIMEOUT_MS);
  if (recording.idleTimer.unref) recording.idleTimer.unref();
}

function finalizeRecording(key) {
  const recording = activeTxRecordings.get(key);
  if (!recording) return;

  activeTxRecordings.delete(key);
  if (recording.idleTimer) clearTimeout(recording.idleTimer);
  if (recording.maxTimer) clearTimeout(recording.maxTimer);

  const { channelId, unitId, startTime, frames } = recording;
  const durationMs = recording.lastFrameTime - startTime;

  if (frames.length === 0) {
    console.log(`[RecordingTap] No frames to save for unit=${unitId} channel=${channelId}`);
    return;
  }

  if (durationMs < MIN_TX_DURATION_MS) {
    console.log(`[RecordingTap] Skipping short TX (${durationMs}ms < ${MIN_TX_DURATION_MS}ms): unit=${unitId} channel=${channelId}`);
    return;
  }

  const recordingCodec = recording.codec || 'opus';
  console.log(`[RecordingTap] Finalizing recording: unit=${unitId} channel=${channelId} frames=${frames.length} duration=${durationMs}ms codec=${recordingCodec}`);

  try {
    const pcmChunks = [];
    let decodeFailures = 0;

    if (recordingCodec === 'pcm') {
      for (const frame of frames) {
        pcmChunks.push(Buffer.isBuffer(frame) ? frame : Buffer.from(frame));
      }
    } else {
      for (let i = 0; i < frames.length; i++) {
        try {
          const pcm = opusCodec.decodeOpusToPcm(frames[i], unitId);
          pcmChunks.push(pcm);
        } catch (decErr) {
          decodeFailures++;
          console.warn(`[RecordingTap] Opus decode error at frame ${i}/${frames.length} for unit=${unitId}: ${decErr.message}`);
        }
      }
    }

    const failureRatio = frames.length > 0 ? decodeFailures / frames.length : 0;
    console.log(`[RecordingTap] Decode summary: unit=${unitId} channel=${channelId} total=${frames.length} decoded=${pcmChunks.length} failed=${decodeFailures} failureRatio=${(failureRatio * 100).toFixed(1)}%`);

    if (pcmChunks.length === 0) {
      console.warn(`[RecordingTap] All frames failed to decode for unit=${unitId} channel=${channelId}`);
      return;
    }

    if (failureRatio > 0.5) {
      console.error(`[RecordingTap] Too many decode failures (${(failureRatio * 100).toFixed(1)}% > 50%) for unit=${unitId} channel=${channelId} — skipping save to avoid broken WAV`);
      return;
    }

    const pcmData = Buffer.concat(pcmChunks);

    const expectedPcmBytes = frames.length * 20 / 1000 * SAMPLE_RATE * 2;
    if (pcmData.length < expectedPcmBytes * 0.25) {
      console.warn(`[RecordingTap] PCM data suspiciously small: ${pcmData.length} bytes vs expected ~${Math.round(expectedPcmBytes)} bytes for unit=${unitId} channel=${channelId} — skipping save`);
      return;
    }

    const wavBuffer = createWavBuffer(pcmData, SAMPLE_RATE, CHANNELS);

    if (!validateWavBuffer(wavBuffer)) {
      console.warn(`[RecordingTap] Invalid WAV buffer for unit=${unitId} channel=${channelId} — skipping save`);
      return;
    }

    sendAudioMessage(channelId, unitId, wavBuffer, durationMs, false)
      .then((msg) => {
        console.log(`[RecordingTap] Audio message saved: id=${msg.id} channel=${channelId} sender=${unitId} duration=${durationMs}ms frames=${frames.length} failed=${decodeFailures}`);
      })
      .catch((err) => {
        console.error(`[RecordingTap] Failed to save audio message:`, err.message);
      });
  } catch (err) {
    console.error(`[RecordingTap] Error processing recording:`, err.message);
  }
}

function handlePttEnd({ channelId, unitId }) {
  const key = txKey(channelId, unitId);
  if (activeTxRecordings.has(key)) {
    setTimeout(() => finalizeRecording(key), 300);
  }
}

function createWavBuffer(pcmData, sampleRate, numChannels) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 30);
  buffer.writeUInt16LE(bitsPerSample, 32);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, 44);

  return buffer;
}

const MIN_WAV_SIZE = 44 + 100;

function validateWavBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_WAV_SIZE) {
    console.warn(`[RecordingTap] WAV validation failed: buffer too small (${buffer?.length || 0} bytes)`);
    return false;
  }
  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    console.warn(`[RecordingTap] WAV validation failed: invalid magic bytes (got "${riff}"/"${wave}")`);
    return false;
  }
  return true;
}

async function cleanupOldAudioFiles() {
  try {
    if (!fs.existsSync(AUDIO_DIR)) return;

    const files = fs.readdirSync(AUDIO_DIR).filter(f => f.endsWith('.wav'));
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      const filepath = path.join(AUDIO_DIR, file);
      let stat;
      try {
        stat = fs.statSync(filepath);
      } catch {
        continue;
      }

      const ageMs = now - stat.mtimeMs;
      if (ageMs < CLEANUP_MAX_AGE_MS) continue;

      try {
        const audioData = await getAudioDataByFilename(file);
        if (audioData) {
          fs.unlinkSync(filepath);
          cleaned++;
        }
      } catch {
        // skip files that fail lookup
      }
    }

    if (cleaned > 0) {
      console.log(`[RecordingTap] Audio cleanup: removed ${cleaned} old WAV file(s) from disk`);
    }
  } catch (err) {
    console.error('[RecordingTap] Audio cleanup error:', err.message);
  }
}

export function setupRecordingTap(audioRelayService, signalingService) {
  audioRelayService.onRecordingTap(handleRecordingFrame);
  signalingService.onPttEnd(handlePttEnd);
  console.log('[RecordingTap] Recording tap and PTT end handler registered');

  const cleanupTimer = setInterval(cleanupOldAudioFiles, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
  console.log(`[RecordingTap] Audio file cleanup scheduled every ${CLEANUP_INTERVAL_MS / 60000} minutes`);
}
