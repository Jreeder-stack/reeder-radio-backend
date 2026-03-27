import { notifyChannelJoin } from '../utils/api.js';
import { signalingManager } from '../signaling/SignalingManager.js';
import { PTT_STATES } from '../constants/pttStates.js';

class LiveKitManager {
  constructor() {
    this.rooms = new Map();
    this.pendingConnections = new Map();
    this.mutedChannels = new Set();
    this._dispatcherMode = false;
    this.primaryTxChannel = null;
    this.pttState = PTT_STATES.IDLE;
    this.pttListeners = new Set();
    this.onStateChange = null;
    this.onDisconnectDuringTx = null;
    this._currentChannel = null;
    this._currentUnit = null;

    this._trackSubscribedListeners = new Set();
    this._trackUnsubscribedListeners = new Set();
    this._participantConnectedListeners = new Set();
    this._participantDisconnectedListeners = new Set();
    this._dataReceivedListeners = new Set();
    this._levelUpdateListeners = new Set();
    this._connectionStateChangeListeners = new Set();
    this._healthChangeListeners = new Set();
  }

  addTrackSubscribedListener(callback) { this._trackSubscribedListeners.add(callback); return () => this._trackSubscribedListeners.delete(callback); }
  addTrackUnsubscribedListener(callback) { this._trackUnsubscribedListeners.add(callback); return () => this._trackUnsubscribedListeners.delete(callback); }
  addParticipantConnectedListener(callback) { this._participantConnectedListeners.add(callback); return () => this._participantConnectedListeners.delete(callback); }
  addParticipantDisconnectedListener(callback) { this._participantDisconnectedListeners.add(callback); return () => this._participantDisconnectedListeners.delete(callback); }
  addDataReceivedListener(callback) { this._dataReceivedListeners.add(callback); return () => this._dataReceivedListeners.delete(callback); }
  addLevelUpdateListener(callback) { this._levelUpdateListeners.add(callback); return () => this._levelUpdateListeners.delete(callback); }
  addConnectionStateChangeListener(callback) { this._connectionStateChangeListeners.add(callback); return () => this._connectionStateChangeListeners.delete(callback); }
  addHealthChangeListener(callback) { this._healthChangeListeners.add(callback); return () => this._healthChangeListeners.delete(callback); }

  _emitConnectionStateChange(channelName, state, error) {
    for (const cb of this._connectionStateChangeListeners) {
      try { cb(channelName, state, error); } catch (_) {}
    }
  }

  setAutoPlayback(_enabled) {}
  startSettingsListener() {}
  prepareConnection() { return Promise.resolve(); }

  async connect(channelName, identity) {
    if (!channelName || !identity) throw new Error('channelName and identity required');
    if (this.rooms.has(channelName)) return this.rooms.get(channelName);
    if (this.pendingConnections.has(channelName)) return this.pendingConnections.get(channelName);

    const p = Promise.resolve().then(() => {
      const conn = {
        state: 'connected',
        channelName,
        unitId: identity,
        localParticipant: { identity },
      };
      this.rooms.set(channelName, conn);
      notifyChannelJoin(channelName, identity);
      this._emitConnectionStateChange(channelName, 'connected');
      return conn;
    }).finally(() => this.pendingConnections.delete(channelName));

    this.pendingConnections.set(channelName, p);
    return p;
  }

  async disconnect(channelName = null) {
    if (!channelName) {
      this.forceReleaseTransmit();
      return;
    }
    if (!this.rooms.has(channelName)) return;
    this.rooms.delete(channelName);
    if (this.primaryTxChannel === channelName) this.primaryTxChannel = null;
    this._emitConnectionStateChange(channelName, 'disconnected');
  }

  async disconnectAll() {
    for (const channelName of [...this.rooms.keys()]) {
      await this.disconnect(channelName);
    }
    this.mutedChannels.clear();
    this.primaryTxChannel = null;
  }

  getRoom(channelName) { return this.rooms.get(channelName) || null; }
  getConnectedChannels() { return [...this.rooms.keys()]; }
  isConnected(channelName) { return this.rooms.has(channelName); }

  setChannelActive(_channelName) {}
  setChannelInactive(_channelName) {}
  waitForRoom(channelName, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const room = this.getRoom(channelName);
        if (room) return resolve(room);
        if (Date.now() - started > timeoutMs) return reject(new Error('Room wait timeout'));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  muteChannel(channelName) { this.mutedChannels.add(channelName); }
  unmuteChannel(channelName) { this.mutedChannels.delete(channelName); }
  muteChannels(channelNames) { channelNames.forEach((ch) => this.muteChannel(ch)); }
  unmuteChannels(channelNames) { channelNames.forEach((ch) => this.unmuteChannel(ch)); }

  sendData(channelName, data) {
    signalingManager.sendChannelData(channelName, data);
  }

  setPrimaryTxChannel(channelName) {
    if (!this.rooms.has(channelName)) return false;
    this.primaryTxChannel = channelName;
    return true;
  }

  getPrimaryTxChannel() { return this.primaryTxChannel || null; }

  _setPttState(newState) {
    const oldState = this.pttState;
    this.pttState = newState;
    for (const cb of this.pttListeners) {
      try { cb(newState, oldState); } catch (_) {}
    }
    if (this.onStateChange) {
      try { this.onStateChange(newState, oldState); } catch (_) {}
    }
  }

  getState() { return this.getPttState(); }
  setCurrentChannel(channelName) { this._currentChannel = channelName; }
  setCurrentUnit(unitId) { this._currentUnit = unitId; }
  setRoom(_room) {}

  addPttStateListener(callback) {
    this.pttListeners.add(callback);
    return () => this.pttListeners.delete(callback);
  }

  getPttState() { return this.pttState; }
  isTransmitting() { return this.pttState === PTT_STATES.TRANSMITTING; }
  canStartTransmit() { return !!this.primaryTxChannel && this.pttState === PTT_STATES.IDLE; }

  async startTransmit() {
    if (!this.canStartTransmit()) return false;
    this._setPttState(PTT_STATES.ARMING);
    this._setPttState(PTT_STATES.TRANSMITTING);
    return true;
  }

  async stopTransmit() {
    if (this.pttState === PTT_STATES.IDLE) return;
    this._setPttState(PTT_STATES.COOLDOWN);
    this._setPttState(PTT_STATES.IDLE);
  }

  forceReleaseTransmit() {
    this._setPttState(PTT_STATES.IDLE);
  }


  canStart() { return this.canStartTransmit(); }
  canStop() { return this.pttState === PTT_STATES.ARMING || this.pttState === PTT_STATES.TRANSMITTING || this.pttState === PTT_STATES.BUSY; }
  async start() { return this.startTransmit(); }
  async stop() { return this.stopTransmit(); }
  forceRelease() { this.forceReleaseTransmit(); }

  setPttErrorHandler(_callback) {}
  setPttDisconnectHandler(_callback) {}

  isChannelHealthy(channelName, { allowReconnecting = false } = {}) {
    if (this.rooms.has(channelName)) return true;
    return allowReconnecting && this.pendingConnections.has(channelName);
  }

  areChannelsHealthy(channelNames, options = {}) {
    return channelNames.every((name) => this.isChannelHealthy(name, options));
  }

  areAnyChannelsBusy() { return false; }
  isChannelBusy() { return false; }
  isChannelReconnecting(channelName) { return this.pendingConnections.has(channelName); }

  getConnectionStatus() {
    const total = this.rooms.size;
    return {
      status: total > 0 ? 'connected' : 'disconnected',
      healthy: total,
      total,
      channels: [...this.rooms.keys()].map((name) => ({ channel: name, connected: true, quality: 'good', state: 'connected' })),
    };
  }

  setDispatcherMode(enabled) { this._dispatcherMode = !!enabled; }
  isDispatcherMode() { return this._dispatcherMode; }
  scheduleDispatcherReconnect(_channelName, _identity) {}

  broadcastData(data) {
    for (const [channelName] of this.rooms) {
      this.sendData(channelName, data);
    }
  }
}

export const livekitManager = new LiveKitManager();
if (typeof window !== 'undefined') window.__livekitManager = livekitManager;
export default livekitManager;
