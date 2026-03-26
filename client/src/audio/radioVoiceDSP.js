let audioContext = null;
let sourceNode = null;
let processedStream = null;
let highPassFilter = null;
let lowPassFilter = null;
let compressor = null;
let gainNode = null;

function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(console.warn);
  }
  return audioContext;
}

export function processRadioVoice(inputStream) {
  const ctx = getAudioContext();
  
  cleanup();
  
  try {
    sourceNode = ctx.createMediaStreamSource(inputStream);
    
    highPassFilter = ctx.createBiquadFilter();
    highPassFilter.type = 'highpass';
    highPassFilter.frequency.value = 80;
    highPassFilter.Q.value = 0.7;
    
    lowPassFilter = ctx.createBiquadFilter();
    lowPassFilter.type = 'lowpass';
    lowPassFilter.frequency.value = 7500;
    lowPassFilter.Q.value = 0.7;
    
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 10;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;
    
    gainNode = ctx.createGain();
    let micGain = 1.4;
    try {
      const stored = localStorage.getItem('app_settings');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.recordingAmplifierEnabled && parsed.recordingAmplifierLevel) {
          micGain = 1.4 * (1.0 + parsed.recordingAmplifierLevel / 100);
        }
      }
    } catch (e) {}
    gainNode.gain.value = micGain;
    
    const destination = ctx.createMediaStreamDestination();
    
    sourceNode
      .connect(highPassFilter)
      .connect(lowPassFilter)
      .connect(compressor)
      .connect(gainNode)
      .connect(destination);
    
    processedStream = destination.stream;
    
    console.log('[RadioDSP] Voice-optimized processing chain created');
    
    return processedStream;
  } catch (err) {
    console.error('[RadioDSP] Failed to create processing chain:', err);
    cleanup();
    return inputStream;
  }
}

export function cleanup() {
  try {
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
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
    processedStream = null;
  } catch (e) {
    console.warn('[RadioDSP] Cleanup warning:', e.message);
  }
}

export function getProcessedStream() {
  return processedStream;
}

export function isProcessing() {
  return processedStream !== null;
}
