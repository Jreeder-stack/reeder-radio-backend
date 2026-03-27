import fs from 'fs';
import path from 'path';
import { opusCodec, SAMPLE_RATE, CHANNELS } from './opusCodec.js';
import { sendAudioMessage } from './messagesService.js';

const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');
const TX_IDLE_TIMEOUT_MS = 2000;
const MAX_TX_DURATION_MS = 60000;

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

const activeTxRecordings = new Map();

function txKey(channelId, unitId) {
  return `${channelId}::${unitId}`;
}

function handleRecordingFrame({ channelId, unitId, sequence, opusPayload, timestamp }) {
  const key = txKey(channelId, unitId);
  let recording = activeTxRecordings.get(key);

  if (!recording) {
    recording = {
      channelId,
      unitId,
      startTime: timestamp,
      lastFrameTime: timestamp,
      frames: [],
      idleTimer: null,
      maxTimer: null,
    };
    activeTxRecordings.set(key, recording);
    console.log(`[RecordingTap] TX recording started: unit=${unitId} channel=${channelId}`);

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

  console.log(`[RecordingTap] Finalizing recording: unit=${unitId} channel=${channelId} frames=${frames.length} duration=${durationMs}ms`);

  try {
    const pcmChunks = [];
    for (const opusFrame of frames) {
      try {
        const pcm = opusCodec.decodeOpusToPcm(opusFrame);
        pcmChunks.push(pcm);
      } catch (decErr) {
        // skip corrupted frames
      }
    }

    if (pcmChunks.length === 0) {
      console.warn(`[RecordingTap] All frames failed to decode for unit=${unitId} channel=${channelId}`);
      return;
    }

    const pcmData = Buffer.concat(pcmChunks);
    const wavBuffer = createWavBuffer(pcmData, SAMPLE_RATE, CHANNELS);

    sendAudioMessage(channelId, unitId, wavBuffer, durationMs, true)
      .then((msg) => {
        console.log(`[RecordingTap] Audio message saved: id=${msg.id} channel=${channelId} sender=${unitId} duration=${durationMs}ms`);
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

export function setupRecordingTap(audioRelayService, signalingService) {
  audioRelayService.onRecordingTap(handleRecordingFrame);
  signalingService.onPttEnd(handlePttEnd);
  console.log('[RecordingTap] Recording tap and PTT end handler registered');
}
