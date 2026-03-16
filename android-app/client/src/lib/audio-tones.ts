/**
 * Audio tone generator for PTT feedback using Web Audio API
 */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

/**
 * Play Motorola 800MHz trunking talk permit tone (3 quick beeps) when transmission is granted
 * Frequency: 800Hz, Pattern: 3 quick beeps ~40ms each with ~30ms gaps
 */
export function playTalkPermitTone(): void {
  (async () => {
    try {
      const context = getAudioContext();

      if (context.state === 'suspended') {
        await context.resume();
      }

      const now = context.currentTime;
      const frequency = 800;
      const beepDuration = 0.040;
      const gap = 0.030;

      for (let i = 0; i < 3; i++) {
        const osc = context.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = frequency;

        const gain = context.createGain();
        const startTime = now + i * (beepDuration + gap);
        gain.gain.setValueAtTime(0.4, startTime);
        gain.gain.setValueAtTime(0, startTime + beepDuration);

        osc.connect(gain);
        gain.connect(context.destination);
        osc.start(startTime);
        osc.stop(startTime + beepDuration);
      }
    } catch (error) {
      console.error('[Audio] Failed to play talk permit tone:', error);
    }
  })();
}

/**
 * Play a busy tone (double beep) when transmission is blocked
 * Two 600ms beeps with gaps
 */
export function playBusyTone(): void {
  (async () => {
    try {
      const context = getAudioContext();

      if (context.state === 'suspended') {
        await context.resume();
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
  })();
}

/**
 * Play an end of transmission tone (lower frequency beep)
 * Frequency: 800Hz, Duration: 150ms
 */
export function playEndOfTransmissionTone(): void {
  (async () => {
    try {
      const context = getAudioContext();

      if (context.state === 'suspended') {
        await context.resume();
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
  })();
}
