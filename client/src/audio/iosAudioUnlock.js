let unlocked = false;
let audioContext = null;
let unlockAttempts = 0;

export function isAudioUnlocked() {
  return unlocked;
}

export async function unlockAudio() {
  if (unlocked) {
    return true;
  }

  unlockAttempts++;
  console.log(`[iOS Audio] Unlock attempt ${unlockAttempts}`);

  try {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
        console.log('[iOS Audio] AudioContext resumed successfully');
      } catch (e) {
        console.warn('[iOS Audio] AudioContext resume failed:', e.message);
      }
    }

    if (audioContext.state === 'running') {
      const silentBuffer = audioContext.createBuffer(1, 1, 22050);
      const source = audioContext.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(audioContext.destination);
      source.start(0);
      console.log('[iOS Audio] Silent buffer played via AudioContext');
    }

    const silentAudio = new Audio();
    silentAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    silentAudio.volume = 0.01;
    silentAudio.playsInline = true;
    
    try {
      await silentAudio.play();
      console.log('[iOS Audio] Silent audio element played - audio unlocked');
      unlocked = true;
      return true;
    } catch (e) {
      console.log('[iOS Audio] Silent audio play failed:', e.message);
      if (audioContext && audioContext.state === 'running') {
        console.log('[iOS Audio] AudioContext is running, marking as unlocked');
        unlocked = true;
        return true;
      }
      return false;
    }
  } catch (e) {
    console.warn('[iOS Audio] Unlock attempt failed:', e.message);
    return false;
  }
}

export function getSharedAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}
