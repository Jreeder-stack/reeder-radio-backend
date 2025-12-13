let audioContext = null;
let bonkOscillator = null;
let bonkGain = null;

function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return audioContext;
}

export function playPermitTone() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  const gain2 = ctx.createGain();
  
  osc1.type = 'sine';
  osc1.frequency.value = 1200;
  osc2.type = 'sine';
  osc2.frequency.value = 1200;
  
  gain1.gain.setValueAtTime(0.3, now);
  gain1.gain.setValueAtTime(0.3, now + 0.05);
  gain1.gain.setValueAtTime(0, now + 0.05);
  
  gain2.gain.setValueAtTime(0, now);
  gain2.gain.setValueAtTime(0, now + 0.1);
  gain2.gain.setValueAtTime(0.3, now + 0.1);
  gain2.gain.setValueAtTime(0.3, now + 0.15);
  gain2.gain.setValueAtTime(0, now + 0.15);
  
  osc1.connect(gain1);
  osc2.connect(gain2);
  gain1.connect(ctx.destination);
  gain2.connect(ctx.destination);
  
  osc1.start(now);
  osc1.stop(now + 0.05);
  osc2.start(now + 0.1);
  osc2.stop(now + 0.15);
}

export function startBonkLoop() {
  stopBonkLoop();
  
  const ctx = getAudioContext();
  
  bonkOscillator = ctx.createOscillator();
  bonkGain = ctx.createGain();
  
  bonkOscillator.type = 'sine';
  bonkOscillator.frequency.value = 400;
  
  bonkGain.gain.value = 0.3;
  
  bonkOscillator.connect(bonkGain);
  bonkGain.connect(ctx.destination);
  
  bonkOscillator.start();
}

export function stopBonkLoop() {
  if (bonkOscillator) {
    try {
      bonkOscillator.stop();
      bonkOscillator.disconnect();
    } catch (e) {}
    bonkOscillator = null;
  }
  if (bonkGain) {
    try {
      bonkGain.disconnect();
    } catch (e) {}
    bonkGain = null;
  }
}
