class ToneEngine {
  constructor() {
    this.audioContext = null;
    this.activeTones = {};
    this.clearAirIntervals = {};
  }

  getContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    return this.audioContext;
  }

  playToneA(duration = 1000) {
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1000, ctx.currentTime);
    
    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration / 1000);
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration / 1000);
    
    return oscillator;
  }

  playToneB(duration = 2000) {
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'square';
    gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
    
    const endTime = ctx.currentTime + duration / 1000;
    let time = ctx.currentTime;
    let high = true;
    
    while (time < endTime) {
      oscillator.frequency.setValueAtTime(high ? 1200 : 800, time);
      time += 0.25;
      high = !high;
    }
    
    gainNode.gain.setValueAtTime(0.2, endTime - 0.1);
    gainNode.gain.exponentialRampToValueAtTime(0.01, endTime);
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    oscillator.start();
    oscillator.stop(endTime);
    
    return oscillator;
  }

  playToneC(duration = 2000) {
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'sine';
    gainNode.gain.setValueAtTime(0.25, ctx.currentTime);
    
    const endTime = ctx.currentTime + duration / 1000;
    const lfoFreq = 15;
    
    oscillator.frequency.setValueAtTime(1000, ctx.currentTime);
    
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(lfoFreq, ctx.currentTime);
    lfoGain.gain.setValueAtTime(300, ctx.currentTime);
    
    lfo.connect(lfoGain);
    lfoGain.connect(oscillator.frequency);
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    lfo.start();
    oscillator.start();
    
    gainNode.gain.setValueAtTime(0.25, endTime - 0.1);
    gainNode.gain.exponentialRampToValueAtTime(0.01, endTime);
    
    oscillator.stop(endTime);
    lfo.stop(endTime);
    
    return oscillator;
  }

  playEmergencyTone(type = 'A', duration = 2000) {
    switch (type) {
      case 'A':
        return this.playToneA(duration);
      case 'B':
        return this.playToneB(duration);
      case 'C':
        return this.playToneC(duration);
      default:
        return this.playToneA(duration);
    }
  }

  playClearAirBeep() {
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(600, ctx.currentTime);
    
    gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.1);
    
    return oscillator;
  }

  startClearAir(channelId, intervalMs = 5000) {
    if (this.clearAirIntervals[channelId]) {
      return;
    }
    
    this.playClearAirBeep();
    
    this.clearAirIntervals[channelId] = setInterval(() => {
      this.playClearAirBeep();
    }, intervalMs);
  }

  stopClearAir(channelId) {
    if (this.clearAirIntervals[channelId]) {
      clearInterval(this.clearAirIntervals[channelId]);
      delete this.clearAirIntervals[channelId];
    }
  }

  stopAllClearAir() {
    Object.keys(this.clearAirIntervals).forEach(channelId => {
      this.stopClearAir(channelId);
    });
  }

  destroy() {
    this.stopAllClearAir();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }
}

export const toneEngine = new ToneEngine();
export default toneEngine;
