class ToneEngine {
  constructor() {
    this.audioContext = null;
    this.activeTones = {};
    this.clearAirIntervals = {};
    this.playingTones = new Set();
    this.onToneStart = null;
    this.onToneEnd = null;
    this.customDestination = null;
    this.externalContext = null;
  }

  getContext() {
    if (this.externalContext) {
      if (this.externalContext.state === 'suspended') {
        this.externalContext.resume();
      }
      return this.externalContext;
    }
    
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    return this.audioContext;
  }

  getDestinationNode() {
    const ctx = this.getContext();
    if (this.customDestination) {
      return this.customDestination;
    }
    return ctx.destination;
  }

  setTxMode(externalContext, destinationNode) {
    this.externalContext = externalContext;
    this.customDestination = destinationNode;
  }

  clearTxMode() {
    this.externalContext = null;
    this.customDestination = null;
  }

  setCustomDestination(node) {
    this.customDestination = node;
  }

  clearCustomDestination() {
    this.customDestination = null;
  }

  isTonePlaying(type) {
    return this.playingTones.has(type);
  }

  isAnyTonePlaying() {
    return this.playingTones.size > 0;
  }

  playToneA(duration = 1000) {
    if (this.isTonePlaying('A')) return null;
    
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1000, ctx.currentTime);
    
    gainNode.gain.setValueAtTime(0.5, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.5, ctx.currentTime + duration / 1000 - 0.001);
    gainNode.gain.setValueAtTime(0, ctx.currentTime + duration / 1000);
    
    oscillator.connect(gainNode);
    gainNode.connect(this.getDestinationNode());
    
    if (this.customDestination) {
      const localGain = ctx.createGain();
      localGain.gain.value = 0.5;
      oscillator.connect(localGain);
      localGain.connect(ctx.destination);
    }
    
    this.playingTones.add('A');
    if (this.onToneStart) this.onToneStart('A');
    
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration / 1000);
    
    oscillator.onended = () => {
      this.playingTones.delete('A');
      if (this.onToneEnd) this.onToneEnd('A');
    };
    
    return oscillator;
  }

  playToneB(duration = 2000) {
    if (this.isTonePlaying('B')) return null;
    
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'square';
    gainNode.gain.setValueAtTime(0.4, ctx.currentTime);
    
    const endTime = ctx.currentTime + duration / 1000;
    let time = ctx.currentTime;
    let high = true;
    
    while (time < endTime) {
      oscillator.frequency.setValueAtTime(high ? 1200 : 800, time);
      time += 0.25;
      high = !high;
    }
    
    gainNode.gain.setValueAtTime(0.4, endTime - 0.001);
    gainNode.gain.setValueAtTime(0, endTime);
    
    oscillator.connect(gainNode);
    gainNode.connect(this.getDestinationNode());
    
    if (this.customDestination) {
      const localGain = ctx.createGain();
      localGain.gain.value = 0.4;
      oscillator.connect(localGain);
      localGain.connect(ctx.destination);
    }
    
    this.playingTones.add('B');
    if (this.onToneStart) this.onToneStart('B');
    
    oscillator.start();
    oscillator.stop(endTime);
    
    oscillator.onended = () => {
      this.playingTones.delete('B');
      if (this.onToneEnd) this.onToneEnd('B');
    };
    
    return oscillator;
  }

  playToneC(duration = 1500) {
    if (this.isTonePlaying('C')) return null;
    
    const ctx = this.getContext();
    const beepDuration = 0.15;
    const gapDuration = 0.15;
    const frequency = 1000;
    
    this.playingTones.add('C');
    if (this.onToneStart) this.onToneStart('C');
    
    const oscillators = [];
    
    for (let i = 0; i < 3; i++) {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
      
      const startTime = ctx.currentTime + i * (beepDuration + gapDuration);
      const stopTime = startTime + beepDuration;
      
      gainNode.gain.setValueAtTime(0, startTime - 0.001);
      gainNode.gain.setValueAtTime(0.5, startTime);
      gainNode.gain.setValueAtTime(0.5, stopTime - 0.001);
      gainNode.gain.setValueAtTime(0, stopTime);
      
      oscillator.connect(gainNode);
      gainNode.connect(this.getDestinationNode());
      
      if (this.customDestination) {
        const localGain = ctx.createGain();
        localGain.gain.setValueAtTime(0, startTime - 0.001);
        localGain.gain.setValueAtTime(0.5, startTime);
        localGain.gain.setValueAtTime(0.5, stopTime - 0.001);
        localGain.gain.setValueAtTime(0, stopTime);
        oscillator.connect(localGain);
        localGain.connect(ctx.destination);
      }
      
      oscillator.start(startTime);
      oscillator.stop(stopTime);
      oscillators.push(oscillator);
    }
    
    oscillators[2].onended = () => {
      this.playingTones.delete('C');
      if (this.onToneEnd) this.onToneEnd('C');
    };
    
    return true;
  }

  playContinuousTone(duration = 5000) {
    if (this.isTonePlaying('CONTINUOUS')) return null;
    
    const ctx = this.getContext();
    const oscillator1 = ctx.createOscillator();
    const oscillator2 = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator1.type = 'sawtooth';
    oscillator1.frequency.setValueAtTime(800, ctx.currentTime);
    
    oscillator2.type = 'square';
    oscillator2.frequency.setValueAtTime(850, ctx.currentTime);
    
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(8, ctx.currentTime);
    lfoGain.gain.setValueAtTime(0.3, ctx.currentTime);
    
    lfo.connect(lfoGain);
    lfoGain.connect(gainNode.gain);
    
    gainNode.gain.setValueAtTime(0.6, ctx.currentTime);
    
    const endTime = ctx.currentTime + duration / 1000;
    
    gainNode.gain.setValueAtTime(0.6, endTime - 0.001);
    gainNode.gain.setValueAtTime(0, endTime);
    
    oscillator1.connect(gainNode);
    oscillator2.connect(gainNode);
    gainNode.connect(this.getDestinationNode());
    
    if (this.customDestination) {
      const localGain = ctx.createGain();
      localGain.gain.value = 0.6;
      gainNode.connect(localGain);
      localGain.connect(ctx.destination);
    }
    
    this.playingTones.add('CONTINUOUS');
    if (this.onToneStart) this.onToneStart('CONTINUOUS');
    
    lfo.start();
    oscillator1.start();
    oscillator2.start();
    
    oscillator1.stop(endTime);
    oscillator2.stop(endTime);
    lfo.stop(endTime);
    
    oscillator1.onended = () => {
      this.playingTones.delete('CONTINUOUS');
      if (this.onToneEnd) this.onToneEnd('CONTINUOUS');
    };
    
    return oscillator1;
  }

  playEmergencyTone(type = 'A', duration = 2000) {
    switch (type) {
      case 'A':
        return this.playToneA(duration);
      case 'B':
        return this.playToneB(duration);
      case 'C':
        return this.playToneC(duration);
      case 'CONTINUOUS':
        return this.playContinuousTone(duration);
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
    
    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.3, ctx.currentTime + 0.099);
    gainNode.gain.setValueAtTime(0, ctx.currentTime + 0.1);
    
    oscillator.connect(gainNode);
    gainNode.connect(this.getDestinationNode());
    
    if (this.customDestination) {
      const localGain = ctx.createGain();
      localGain.gain.value = 0.3;
      oscillator.connect(localGain);
      localGain.connect(ctx.destination);
    }
    
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
    this.playingTones.clear();
    this.customDestination = null;
    this.externalContext = null;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }
}

export const toneEngine = new ToneEngine();
export default toneEngine;
