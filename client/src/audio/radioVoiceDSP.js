let nodes = null;

export function processRadioVoice(ctx, inputSourceNode) {
  if (nodes) {
    cleanup();
  }

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 150;
  highpass.Q.value = 0.7;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.15;

  const gain = ctx.createGain();
  gain.gain.value = 2.0;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 1;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;

  inputSourceNode.connect(highpass);
  highpass.connect(compressor);
  compressor.connect(gain);
  gain.connect(limiter);

  nodes = { highpass, compressor, gain, limiter, input: inputSourceNode };

  return limiter;
}

export function cleanup() {
  if (!nodes) return;
  try { nodes.input.disconnect(nodes.highpass); } catch (_) {}
  try { nodes.highpass.disconnect(nodes.compressor); } catch (_) {}
  try { nodes.compressor.disconnect(nodes.gain); } catch (_) {}
  try { nodes.gain.disconnect(nodes.limiter); } catch (_) {}
  nodes = null;
}

export function isProcessing() {
  return nodes !== null;
}
