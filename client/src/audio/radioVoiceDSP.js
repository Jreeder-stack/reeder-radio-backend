let nodes = null;
let currentSettings = {
  incomingVolume: 100,
  playbackAmplifier: false,
};

export function processRadioVoice(ctx, inputSourceNode, settings) {
  if (nodes) {
    cleanup();
  }

  if (settings) {
    currentSettings = { ...currentSettings, ...settings };
  }

  const gain = ctx.createGain();
  gain.gain.value = computeGainValue(currentSettings);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 1;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;

  inputSourceNode.connect(gain);
  gain.connect(limiter);

  nodes = { gain, limiter, input: inputSourceNode };

  return limiter;
}

function computeGainValue(s) {
  let vol = (s.incomingVolume ?? 100) / 100;
  if (s.playbackAmplifier) {
    vol *= 2.0;
  }
  return vol;
}

export function updateSettings(settings) {
  currentSettings = { ...currentSettings, ...settings };
  if (nodes && nodes.gain) {
    nodes.gain.gain.value = computeGainValue(currentSettings);
  }
}

export function cleanup() {
  if (!nodes) return;
  try { nodes.input.disconnect(nodes.gain); } catch (_) {}
  try { nodes.gain.disconnect(nodes.limiter); } catch (_) {}
  nodes = null;
}

export function isProcessing() {
  return nodes !== null;
}
