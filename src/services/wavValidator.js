const MIN_WAV_SIZE = 44;
const PCM_FORMAT = 1;
const STANDARD_FMT_SIZE = 16;
const STANDARD_DATA_OFFSET = 36;

export function isValidWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_WAV_SIZE) return false;
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return false;
  if (buf.slice(8, 12).toString('ascii') !== 'WAVE') return false;

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    const chunkEnd = chunkDataOffset + chunkSize;
    if (chunkEnd > buf.length) return false;

    if (chunkId === 'fmt ' && chunkSize >= STANDARD_FMT_SIZE) {
      const audioFormat = buf.readUInt16LE(chunkDataOffset);
      const channels = buf.readUInt16LE(chunkDataOffset + 2);
      const sampleRate = buf.readUInt32LE(chunkDataOffset + 4);
      const byteRate = buf.readUInt32LE(chunkDataOffset + 8);
      const blockAlign = buf.readUInt16LE(chunkDataOffset + 12);
      const bitsPerSample = buf.readUInt16LE(chunkDataOffset + 14);
      const bytesPerSample = bitsPerSample / 8;
      fmt = {
        audioFormat,
        channels,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample,
        valid:
          audioFormat === PCM_FORMAT
          && channels > 0
          && sampleRate > 0
          && Number.isInteger(bytesPerSample)
          && bytesPerSample > 0
          && blockAlign === channels * bytesPerSample
          && byteRate === sampleRate * blockAlign,
      };
    } else if (chunkId === 'data') {
      data = { size: chunkSize };
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  return !!fmt?.valid && !!data && data.size > 0;
}

export function createPcmWavBuffer(pcmData, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  if (!Buffer.isBuffer(pcmData)) {
    throw new TypeError('PCM data must be a Buffer');
  }

  const bytesPerSample = bitsPerSample / 8;
  if (
    !Number.isInteger(bytesPerSample)
    || bytesPerSample <= 0
    || !Number.isInteger(channels)
    || channels <= 0
    || !Number.isInteger(sampleRate)
    || sampleRate <= 0
  ) {
    throw new RangeError('Invalid PCM WAV format');
  }

  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(MIN_WAV_SIZE + pcmData.length);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcmData.length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(STANDARD_FMT_SIZE, 16);
  buffer.writeUInt16LE(PCM_FORMAT, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', STANDARD_DATA_OFFSET);
  buffer.writeUInt32LE(pcmData.length, 40);
  pcmData.copy(buffer, MIN_WAV_SIZE);

  return buffer;
}

export function repairLegacyRecordingTapWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_WAV_SIZE) return null;
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buf.slice(8, 12).toString('ascii') !== 'WAVE') return null;
  if (buf.slice(12, 16).toString('ascii') !== 'fmt ') return null;
  if (buf.readUInt32LE(16) !== STANDARD_FMT_SIZE) return null;
  if (buf.readUInt16LE(20) !== PCM_FORMAT) return null;
  if (buf.slice(STANDARD_DATA_OFFSET, STANDARD_DATA_OFFSET + 4).toString('ascii') !== 'data') return null;

  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const misplacedBitsPerSample = buf.readUInt16LE(32);
  const storedBitsPerSample = buf.readUInt16LE(34);
  const bytesPerSample = misplacedBitsPerSample / 8;

  if (
    channels <= 0
    || sampleRate <= 0
    || storedBitsPerSample !== 0
    || !Number.isInteger(bytesPerSample)
    || bytesPerSample <= 0
  ) {
    return null;
  }

  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const legacyByteRate = (byteRate & 0xffff) | (blockAlign << 16);
  if (buf.readUInt32LE(28) !== legacyByteRate) return null;

  const repaired = Buffer.from(buf);
  repaired.writeUInt32LE(byteRate, 28);
  repaired.writeUInt16LE(blockAlign, 32);
  repaired.writeUInt16LE(misplacedBitsPerSample, 34);

  return isValidWav(repaired) ? repaired : null;
}

export function prepareWavForPlayback(buf) {
  if (isValidWav(buf)) {
    return { buffer: buf, repairedLegacyHeader: false };
  }

  const repaired = repairLegacyRecordingTapWav(buf);
  if (repaired) {
    return { buffer: repaired, repairedLegacyHeader: true };
  }

  return null;
}

export class InvalidAudioBufferError extends Error {
  constructor(reason, details = {}) {
    super(`Invalid audio buffer: ${reason}`);
    this.name = 'InvalidAudioBufferError';
    this.reason = reason;
    this.details = details;
  }
}
