let audioContext = null;
let sourceNode = null;
let processedStream = null;
let highPassFilter = null;
let lowPassFilter = null;
let compressor = null;
let gainNode = null;
let waveShaperNode = null;

function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(console.warn);
  }
  return audioContext;
}

function createSaturationCurve(amount = 0.4) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  
  return curve;
}

export function processRadioVoice(inputStream) {
  const ctx = getAudioContext();
  
  cleanup();
  
  try {
    sourceNode = ctx.createMediaStreamSource(inputStream);
    
    highPassFilter = ctx.createBiquadFilter();
    highPassFilter.type = 'highpass';
    highPassFilter.frequency.value = 300;
    highPassFilter.Q.value = 0.7;
    
    lowPassFilter = ctx.createBiquadFilter();
    lowPassFilter.type = 'lowpass';
    lowPassFilter.frequency.value = 3400;
    lowPassFilter.Q.value = 0.7;
    
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 6;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;
    
    waveShaperNode = ctx.createWaveShaper();
    waveShaperNode.curve = createSaturationCurve(0.3);
    waveShaperNode.oversample = '2x';
    
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
      .connect(waveShaperNode)
      .connect(gainNode)
      .connect(destination);
    
    processedStream = destination.stream;
    
    console.log('[RadioDSP] Radio voice processing chain created');
    
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
    if (waveShaperNode) {
      waveShaperNode.disconnect();
      waveShaperNode = null;
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
