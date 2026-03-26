let highPassFilter = null;
let lowPassFilter = null;
let compressor = null;
let gainNode = null;
let limiterNode = null;

export function processRadioVoice(ctx, inputSourceNode) {
  cleanup();

  try {
    highPassFilter = ctx.createBiquadFilter();
    highPassFilter.type = 'highpass';
    highPassFilter.frequency.value = 80;
    highPassFilter.Q.value = 0.7;

    lowPassFilter = ctx.createBiquadFilter();
    lowPassFilter.type = 'lowpass';
    lowPassFilter.frequency.value = 10000;
    lowPassFilter.Q.value = 0.7;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 10;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    gainNode = ctx.createGain();
    let micGain = 1.0;
    try {
      const stored = localStorage.getItem('app_settings');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.recordingAmplifierEnabled && parsed.recordingAmplifierLevel) {
          micGain = 1.0 + parsed.recordingAmplifierLevel / 100;
        }
      }
    } catch (e) {}
    gainNode.gain.value = micGain;

    limiterNode = ctx.createDynamicsCompressor();
    limiterNode.threshold.value = -1;
    limiterNode.knee.value = 0;
    limiterNode.ratio.value = 20;
    limiterNode.attack.value = 0.001;
    limiterNode.release.value = 0.01;

    inputSourceNode
      .connect(highPassFilter)
      .connect(lowPassFilter)
      .connect(compressor)
      .connect(gainNode)
      .connect(limiterNode);

    console.log('[RadioDSP] Voice-optimized processing chain created');

    return limiterNode;
  } catch (err) {
    console.error('[RadioDSP] Failed to create processing chain:', err);
    cleanup();
    return inputSourceNode;
  }
}

export function cleanup() {
  try {
    if (highPassFilter) {
      highPassFilter.disconnect();
      highPassFilter = null;
    }
    if (lowPassFilter) {
      lowPassFilter.disconnect();
      lowPassFilter = null;
    }
    if (compressor) {
      compressor.disconnect();
      compressor = null;
    }
    if (gainNode) {
      gainNode.disconnect();
      gainNode = null;
    }
    if (limiterNode) {
      limiterNode.disconnect();
      limiterNode = null;
    }
  } catch (e) {
    console.warn('[RadioDSP] Cleanup warning:', e.message);
  }
}

export function isProcessing() {
  return gainNode !== null;
}
