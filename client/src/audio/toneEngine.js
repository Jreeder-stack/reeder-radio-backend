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
    this.busyToneOscillator = null;
    this.busyToneGain = null;
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

  // Alert tone - 2.5 second 1000Hz sine, abrupt start/stop
  playToneA(duration = 2500) {
    if (this.isTonePlaying('A')) return null;
    
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.value = 1000;
    gainNode.gain.value = 0.5;
    
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

  // MDC tone - 2 second alternating 1200/800Hz square wave, abrupt start/stop
  playToneB(duration = 2000) {
    if (this.isTonePlaying('B')) return null;
    
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'square';
    gainNode.gain.value = 0.4;
    
    const endTime = ctx.currentTime + duration / 1000;
    let time = ctx.currentTime;
    let high = true;
    
    while (time < endTime) {
      oscillator.frequency.setValueAtTime(high ? 1200 : 800, time);
      time += 0.25;
      high = !high;
    }
    
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

  // Pre-alert tone - 4 beeps at 1000Hz, abrupt start/stop each beep
  playToneC(duration = 3000) {
    if (this.isTonePlaying('C')) return null;
    
    const ctx = this.getContext();
    const beepDuration = 0.30;
    const gapDuration = 0.20;
    const frequency = 1000;
    const beepCount = 4;
    
    this.playingTones.add('C');
    if (this.onToneStart) this.onToneStart('C');
    
    // Use a single oscillator with gain gating for all beeps
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gainNode.gain.value = 0;
    
    oscillator.connect(gainNode);
    gainNode.connect(this.getDestinationNode());
    
    let localGain = null;
    if (this.customDestination) {
      localGain = ctx.createGain();
      localGain.gain.value = 0;
      oscillator.connect(localGain);
      localGain.connect(ctx.destination);
    }
    
    // Schedule all beeps with hard on/off
    for (let i = 0; i < beepCount; i++) {
      const startTime = ctx.currentTime + i * (beepDuration + gapDuration);
      const stopTime = startTime + beepDuration;
      
      gainNode.gain.setValueAtTime(0.5, startTime);
      gainNode.gain.setValueAtTime(0, stopTime);
      
      if (localGain) {
        localGain.gain.setValueAtTime(0.5, startTime);
        localGain.gain.setValueAtTime(0, stopTime);
      }
    }
    
    const totalDuration = beepCount * (beepDuration + gapDuration);
    
    oscillator.start();
    oscillator.stop(ctx.currentTime + totalDuration);
    
    oscillator.onended = () => {
      this.playingTones.delete('C');
      if (this.onToneEnd) this.onToneEnd('C');
    };
    
    return true;
  }

  // Authorization tone - 2 quick beeps at 1200Hz, abrupt
  playAuthorizationTone() {
    const ctx = this.getContext();
    const beepDuration = 0.05;
    const gapDuration = 0.05;
    const frequency = 1200;
    
    for (let i = 0; i < 2; i++) {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gainNode.gain.value = 0.4;
      
      const startTime = ctx.currentTime + i * (beepDuration + gapDuration);
      const stopTime = startTime + beepDuration;
      
      oscillator.connect(gainNode);
      gainNode.connect(this.getDestinationNode());
      
      if (this.customDestination) {
        const localGain = ctx.createGain();
        localGain.gain.value = 0.4;
        oscillator.connect(localGain);
        localGain.connect(ctx.destination);
      }
      
      oscillator.start(startTime);
      oscillator.stop(stopTime);
    }
  }

  startBusyTone() {
    if (this.busyToneOscillator) return;
    
    const ctx = this.getContext();
    this.busyToneOscillator = ctx.createOscillator();
    this.busyToneGain = ctx.createGain();
    
    this.busyToneOscillator.type = 'sine';
    this.busyToneOscillator.frequency.value = 480;
    this.busyToneGain.gain.value = 0.4;
    
    this.busyToneOscillator.connect(this.busyToneGain);
    this.busyToneGain.connect(ctx.destination);
    
    this.busyToneOscillator.start();
  }

  stopBusyTone() {
    if (this.busyToneOscillator) {
      try {
        this.busyToneOscillator.stop();
      } catch (e) {}
      this.busyToneOscillator = null;
      this.busyToneGain = null;
    }
  }

  // Continuous alarm - 5 second aggressive 800/850Hz + LFO, abrupt start/stop
  playContinuousTone(duration = 5000) {
    if (this.isTonePlaying('CONTINUOUS')) return null;
    
    const ctx = this.getContext();
    const oscillator1 = ctx.createOscillator();
    const oscillator2 = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator1.type = 'sawtooth';
    oscillator1.frequency.value = 800;
    
    oscillator2.type = 'square';
    oscillator2.frequency.value = 850;
    
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'square';
    lfo.frequency.value = 8;
    lfoGain.gain.value = 0.3;
    
    lfo.connect(lfoGain);
    lfoGain.connect(gainNode.gain);
    
    gainNode.gain.value = 0.6;
    
    const endTime = ctx.currentTime + duration / 1000;
    
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

  // Clear air beep - 100ms 600Hz, abrupt
  playClearAirBeep() {
    const ctx = this.getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.value = 600;
    gainNode.gain.value = 0.3;
    
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
