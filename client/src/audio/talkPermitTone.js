let permitAudio = null;

export function playPermitTone() {
  try {
    if (permitAudio) {
      permitAudio.pause();
      permitAudio.currentTime = 0;
    }
    permitAudio = new Audio('/sounds/talk-permit.wav');
    permitAudio.volume = 0.6;
    permitAudio.play().catch(function(e) {
      console.warn('[TalkPermit] Playback failed:', e.message);
    });
  } catch (e) {
    console.warn('[TalkPermit] Failed to create audio:', e.message);
  }
}

let bonkOscillator = null;
let bonkGain = null;
let bonkCtx = null;

function getBonkContext() {
  if (!bonkCtx || bonkCtx.state === 'closed') {
    bonkCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (bonkCtx.state === 'suspended') {
    bonkCtx.resume();
  }
  return bonkCtx;
}

export function startBonkLoop() {
  stopBonkLoop();

  var ctx = getBonkContext();

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
