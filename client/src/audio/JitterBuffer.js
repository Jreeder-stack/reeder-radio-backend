console.log('[AUDIO-REBUILD] JitterBuffer module loaded — intentionally disabled during rebuild');

const DEFAULT_BUFFER_DEPTH = 4;
const FRAME_SIZE = 960;

class JitterBuffer {
  constructor() {
    this._buffer = new Map();
    this._outputQueue = [];
  }

  push() {
    console.log('[AUDIO-REBUILD] JitterBuffer.push() intentionally disabled');
  }

  getFrames() {
    console.log('[AUDIO-REBUILD] JitterBuffer.getFrames() intentionally disabled');
    return [];
  }

  reset() {
    console.log('[AUDIO-REBUILD] JitterBuffer.reset() intentionally disabled');
    this._buffer.clear();
    this._outputQueue = [];
  }

  get stats() {
    return {
      buffered: 0,
      lost: 0,
      recovered: 0,
      received: 0,
      filling: false,
    };
  }
}

export { JitterBuffer, DEFAULT_BUFFER_DEPTH, FRAME_SIZE };
