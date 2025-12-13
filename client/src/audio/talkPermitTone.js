let audioContext = null;
let bonkInterval = null;

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

export function playBonk() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  
  osc.type = 'sine';
  osc.frequency.setValueAtTime(480, now);
  osc.frequency.exponentialRampToValueAtTime(320, now + 0.15);
  
  gain.gain.setValueAtTime(0.35, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
  
  osc.connect(gain);
  gain.connect(ctx.destination);
  
  osc.start(now);
  osc.stop(now + 0.2);
}

export function startBonkLoop() {
  stopBonkLoop();
  playBonk();
  bonkInterval = setInterval(() => {
    playBonk();
  }, 400);
}

export function stopBonkLoop() {
  if (bonkInterval) {
    clearInterval(bonkInterval);
    bonkInterval = null;
  }
}
