const MIN_WAV_SIZE = 44;

export function isValidWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_WAV_SIZE) return false;
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return false;
  if (buf.slice(8, 12).toString('ascii') !== 'WAVE') return false;
  return true;
}

export class InvalidAudioBufferError extends Error {
  constructor(reason, details = {}) {
    super(`Invalid audio buffer: ${reason}`);
    this.name = 'InvalidAudioBufferError';
    this.reason = reason;
    this.details = details;
  }
}
