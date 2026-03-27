console.log('[AUDIO-REBUILD] OpusBrowserCodec module loaded — all codec functionality intentionally disabled during rebuild');

class OpusBrowserCodec {
  constructor() {
    this._ready = false;
  }

  async init() {
    console.log('[AUDIO-REBUILD] OpusBrowserCodec.init() intentionally disabled');
  }

  get ready() {
    return false;
  }

  encode() {
    console.log('[AUDIO-REBUILD] OpusBrowserCodec.encode() intentionally disabled');
    return new Uint8Array(0);
  }

  decode() {
    console.log('[AUDIO-REBUILD] OpusBrowserCodec.decode() intentionally disabled');
    return new Int16Array(960);
  }

  decodeFEC() {
    console.log('[AUDIO-REBUILD] OpusBrowserCodec.decodeFEC() intentionally disabled');
    return new Int16Array(960);
  }

  decodePLC() {
    console.log('[AUDIO-REBUILD] OpusBrowserCodec.decodePLC() intentionally disabled');
    return new Int16Array(960);
  }

  destroy() {
    console.log('[AUDIO-REBUILD] OpusBrowserCodec.destroy() intentionally disabled');
  }
}

export async function initOpusBrowserCodec() {
  console.log('[AUDIO-REBUILD] initOpusBrowserCodec() intentionally disabled');
  return null;
}

export function getOpusBrowserCodec() {
  return null;
}

export default OpusBrowserCodec;
