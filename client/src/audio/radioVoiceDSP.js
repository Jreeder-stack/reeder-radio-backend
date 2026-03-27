console.log('[AUDIO-REBUILD] radioVoiceDSP module loaded — intentionally disabled during rebuild');

export function processRadioVoice(ctx, inputSourceNode) {
  console.log('[AUDIO-REBUILD] processRadioVoice() intentionally disabled');
  return inputSourceNode;
}

export function cleanup() {
  console.log('[AUDIO-REBUILD] radioVoiceDSP.cleanup() intentionally disabled');
}

export function isProcessing() {
  return false;
}
