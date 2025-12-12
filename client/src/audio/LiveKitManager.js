import { Room, RoomEvent, Track, DataPacket_Kind } from 'livekit-client';
import { getToken } from '../utils/api.js';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || 
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

class LiveKitManager {
  constructor() {
    this.rooms = new Map();
    this.audioContext = null;
    this.channelGainNodes = new Map();
    this.levelAnimations = new Map();
    this.mutedChannels = new Set();
    this.audioElements = new WeakMap();
    
    this.onTrackSubscribed = null;
    this.onTrackUnsubscribed = null;
    this.onParticipantConnected = null;
    this.onParticipantDisconnected = null;
    this.onDataReceived = null;
    this.onLevelUpdate = null;
    this.onConnectionStateChange = null;
  }

  _getAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(e => console.warn('[LiveKit] AudioContext resume failed:', e));
    }
    return this.audioContext;
  }

  async connect(channelName, identity) {
    if (this.rooms.has(channelName)) {
      console.log(`[LiveKit] Already connected to ${channelName}`);
      return this.rooms.get(channelName);
    }

    console.log(`[LiveKit] Connecting to ${channelName} as ${identity}...`);

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this._setupRoomEventHandlers(room, channelName);

    try {
      const token = await getToken(identity, channelName);
      await room.connect(LIVEKIT_URL, token);
      
      this.rooms.set(channelName, room);
      console.log(`[LiveKit] Connected to ${channelName}`);
      
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(channelName, 'connected');
      }

      return room;
    } catch (err) {
      console.error(`[LiveKit] Failed to connect to ${channelName}:`, err);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(channelName, 'failed', err);
      }
      throw err;
    }
  }

  _setupRoomEventHandlers(room, channelName) {
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      console.log(`[LiveKit] Track subscribed: ${track.kind} from ${participant.identity} on ${channelName}`);
      
      if (track.kind === Track.Kind.Audio) {
        this._handleAudioTrack(track, participant, channelName);
      }
      
      if (this.onTrackSubscribed) {
        this.onTrackSubscribed(channelName, track, participant);
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      console.log(`[LiveKit] Track unsubscribed from ${participant.identity} on ${channelName}`);
      this._handleTrackUnsubscribed(channelName, track, participant);
      
      if (this.onTrackUnsubscribed) {
        this.onTrackUnsubscribed(channelName, track, participant);
      }
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      console.log(`[LiveKit] Participant joined ${channelName}: ${participant.identity}`);
      if (this.onParticipantConnected) {
        this.onParticipantConnected(channelName, participant);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log(`[LiveKit] Participant left ${channelName}: ${participant.identity}`);
      if (this.onParticipantDisconnected) {
        this.onParticipantDisconnected(channelName, participant);
      }
    });

    room.on(RoomEvent.DataReceived, (payload, participant, kind) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (this.onDataReceived) {
          this.onDataReceived(channelName, data, participant);
        }
      } catch (e) {
        console.warn('[LiveKit] Failed to parse data message:', e);
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log(`[LiveKit] Disconnected from ${channelName}`);
      this._cleanupChannel(channelName);
      
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(channelName, 'disconnected');
      }
    });
  }

  _handleAudioTrack(track, participant, channelName) {
    const ctx = this._getAudioContext();
    const audioElem = track.attach();
    
    try {
      const source = ctx.createMediaElementSource(audioElem);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      
      const gainNode = ctx.createGain();
      gainNode.gain.value = this.mutedChannels.has(channelName) ? 0 : 1;
      
      source.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      this.channelGainNodes.set(channelName, gainNode);
      this.audioElements.set(audioElem, { source, track, channelName });
      
      this._startLevelMonitor(channelName, analyser);
      
    } catch (err) {
      console.warn('[LiveKit] Using direct audio playback for', channelName);
      audioElem.volume = this.mutedChannels.has(channelName) ? 0 : 1;
      audioElem.play().catch(e => console.warn('[LiveKit] Autoplay blocked:', e));
    }
  }

  _startLevelMonitor(channelName, analyser) {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    const update = () => {
      if (!this.rooms.has(channelName)) return;
      
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      
      if (this.onLevelUpdate) {
        this.onLevelUpdate(channelName, Math.min(100, avg * 1.5));
      }
      
      this.levelAnimations.set(channelName, requestAnimationFrame(update));
    };
    
    update();
  }

  _handleTrackUnsubscribed(channelName, track, participant) {
    const animationId = this.levelAnimations.get(channelName);
    if (animationId) {
      cancelAnimationFrame(animationId);
      this.levelAnimations.delete(channelName);
    }
    
    if (this.onLevelUpdate) {
      this.onLevelUpdate(channelName, 0);
    }
    
    try {
      track.detach().forEach(el => {
        const cached = this.audioElements.get(el);
        if (cached) {
          this.audioElements.delete(el);
        }
        el.remove();
      });
    } catch (e) {}
  }

  _cleanupChannel(channelName) {
    this.rooms.delete(channelName);
    this.channelGainNodes.delete(channelName);
    this.mutedChannels.delete(channelName);
    
    const animationId = this.levelAnimations.get(channelName);
    if (animationId) {
      cancelAnimationFrame(animationId);
      this.levelAnimations.delete(channelName);
    }
  }

  getRoom(channelName) {
    return this.rooms.get(channelName);
  }

  getConnectedChannels() {
    return Array.from(this.rooms.keys());
  }

  isConnected(channelName) {
    return this.rooms.has(channelName);
  }

  isChannelBusy(channelName) {
    const room = this.rooms.get(channelName);
    if (!room) return false;
    
    for (const [, participant] of room.remoteParticipants) {
      for (const [, pub] of participant.audioTrackPublications) {
        if (pub.track && !pub.isMuted) {
          return true;
        }
      }
    }
    return false;
  }

  areAnyChannelsBusy(channelNames) {
    return channelNames.some(name => this.isChannelBusy(name));
  }

  muteChannel(channelName) {
    this.mutedChannels.add(channelName);
    const gainNode = this.channelGainNodes.get(channelName);
    if (gainNode) {
      gainNode.gain.value = 0;
    }
  }

  unmuteChannel(channelName) {
    this.mutedChannels.delete(channelName);
    const gainNode = this.channelGainNodes.get(channelName);
    if (gainNode) {
      gainNode.gain.value = 1;
    }
  }

  muteChannels(channelNames) {
    channelNames.forEach(name => this.muteChannel(name));
  }

  unmuteChannels(channelNames) {
    channelNames.forEach(name => this.unmuteChannel(name));
  }

  sendData(channelName, data) {
    const room = this.rooms.get(channelName);
    if (!room || room.state !== 'connected') return;

    try {
      const payload = new TextEncoder().encode(JSON.stringify(data));
      room.localParticipant.publishData(payload, DataPacket_Kind.RELIABLE);
    } catch (err) {
      console.warn(`[LiveKit] Failed to send data to ${channelName}:`, err.message);
    }
  }

  broadcastData(data) {
    for (const [channelName, room] of this.rooms) {
      if (room.state === 'connected') {
        this.sendData(channelName, data);
      }
    }
  }

  async disconnect(channelName) {
    const room = this.rooms.get(channelName);
    if (!room) return;

    console.log(`[LiveKit] Disconnecting from ${channelName}`);
    this._cleanupChannel(channelName);
    
    try {
      await room.disconnect();
    } catch (e) {
      console.warn(`[LiveKit] Disconnect warning for ${channelName}:`, e.message);
    }
  }

  async disconnectAll() {
    console.log('[LiveKit] Disconnecting all rooms');
    
    for (const [channelName] of this.rooms) {
      const animationId = this.levelAnimations.get(channelName);
      if (animationId) {
        cancelAnimationFrame(animationId);
      }
    }
    
    const disconnectPromises = Array.from(this.rooms.values()).map(room => {
      try {
        return room.disconnect();
      } catch (e) {
        return Promise.resolve();
      }
    });
    
    await Promise.allSettled(disconnectPromises);
    
    this.rooms.clear();
    this.channelGainNodes.clear();
    this.mutedChannels.clear();
    this.levelAnimations.clear();
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        await this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
    
    console.log('[LiveKit] All rooms disconnected');
  }
}

export const livekitManager = new LiveKitManager();
export default livekitManager;
