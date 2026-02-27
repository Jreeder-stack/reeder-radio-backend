let audioContext = null;
let permitAudio = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

export function playTalkPermitTone() {
  try {
    if (permitAudio) {
      permitAudio.pause();
      permitAudio.currentTime = 0;
    }
    permitAudio = new Audio('/sounds/talk-permit.wav');
    permitAudio.volume = 0.6;
    permitAudio.play().catch(function(e) {
      console.warn('[AudioTones] Talk permit playback failed:', e.message);
    });
  } catch (e) {
    console.error('[Audio] Failed to play talk permit tone:', e);
  }
}

export function playBusyTone() {
  try {
    const context = getAudioContext();
    
    if (context.state === 'suspended') {
      context.resume();
    }

    const now = context.currentTime;
    const frequency = 1000;
    const beepDuration = 0.2;
    const gap = 0.2;

    for (let i = 0; i < 2; i++) {
      const startTime = now + i * (beepDuration + gap);
      
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.3, startTime);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + beepDuration);

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(startTime);
      oscillator.stop(startTime + beepDuration);
    }
  } catch (error) {
    console.error('[Audio] Failed to play busy tone:', error);
  }
}

export function playEndOfTransmissionTone() {
  try {
    const context = getAudioContext();
    
    if (context.state === 'suspended') {
      context.resume();
    }

    const now = context.currentTime;
    const duration = 0.15;
    const frequency = 800;

    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start(now);
    oscillator.stop(now + duration);
  } catch (error) {
    console.error('[Audio] Failed to play end of transmission tone:', error);
  }
}
