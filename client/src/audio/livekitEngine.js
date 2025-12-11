import { Room, RoomEvent, Track, DataPacket_Kind } from 'livekit-client';
import { getToken } from '../utils/api.js';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;

const connectedAudioElements = new WeakMap();

class LiveKitEngine {
  constructor() {
    this.rooms = {};
    this.audioContext = null;
    this.levelAnimations = {};
    this.onTrackSubscribed = null;
    this.onTrackUnsubscribed = null;
    this.onParticipantConnected = null;
    this.onParticipantDisconnected = null;
    this.onDataReceived = null;
    this.onLevelUpdate = null;
    
    this.txGraph = null;
    this.publishedTracks = {};
    this.channelGainNodes = {};
    this.mutedTxChannels = new Set();
  }

  getAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    return this.audioContext;
  }

  getOrCreateMediaElementSource(audioElement, track) {
    const audioContext = this.getAudioContext();
    
    if (connectedAudioElements.has(audioElement)) {
      const cachedSource = connectedAudioElements.get(audioElement);
      if (cachedSource.context === audioContext && audioContext.state !== 'closed') {
        return { source: cachedSource, element: audioElement };
      }
      try {
        track.detach(audioElement);
      } catch (e) {}
      audioElement.remove();
      connectedAudioElements.delete(audioElement);
    }
    
    try {
      const source = audioContext.createMediaElementSource(audioElement);
      connectedAudioElements.set(audioElement, source);
      return { source, element: audioElement };
    } catch (err) {
      try {
        track.detach(audioElement);
      } catch (e) {}
      audioElement.remove();
      connectedAudioElements.delete(audioElement);
      
      const freshAudio = new Audio();
      freshAudio.autoplay = true;
      const freshElement = track.attach(freshAudio);
      
      try {
        const source = this.audioContext.createMediaElementSource(freshElement);
        connectedAudioElements.set(freshElement, source);
        return { source, element: freshElement };
      } catch (retryErr) {
        return { source: null, element: freshElement };
      }
    }
  }

  async connectToChannel(channelName, identity) {
    if (this.rooms[channelName]) {
      return this.rooms[channelName];
    }

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (this.onParticipantConnected) {
        this.onParticipantConnected(channelName, participant);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (this.onParticipantDisconnected) {
        this.onParticipantDisconnected(channelName, participant);
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === 'audio') {
        this.handleAudioTrack(channelName, track, participant);
      }
      if (this.onTrackSubscribed) {
        this.onTrackSubscribed(channelName, track, participant);
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      this.handleTrackUnsubscribed(channelName, track, participant);
      if (this.onTrackUnsubscribed) {
        this.onTrackUnsubscribed(channelName, track, participant);
      }
    });

    room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (this.onDataReceived) {
        try {
          const decoder = new TextDecoder();
          const message = JSON.parse(decoder.decode(payload));
          this.onDataReceived(channelName, message, participant);
        } catch (err) {
          console.error('Error parsing data message:', err);
        }
      }
    });

    const token = await getToken(identity, channelName);
    await room.connect(LIVEKIT_URL, token);
    
    this.rooms[channelName] = room;
    return room;
  }

  handleAudioTrack(channelName, track, participant) {
    const audioContext = this.getAudioContext();
    const audioElem = track.attach();
    
    const { source, element } = this.getOrCreateMediaElementSource(audioElem, track);
    
    if (!source) {
      return;
    }
    
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;
    
    const gainNode = audioContext.createGain();
    gainNode.gain.value = this.mutedTxChannels.has(channelName) ? 0 : 1;
    
    this.channelGainNodes[channelName] = gainNode;
    
    source.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const updateLevel = () => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      if (this.onLevelUpdate) {
        this.onLevelUpdate(channelName, Math.min(100, avg * 1.5));
      }
      this.levelAnimations[channelName] = requestAnimationFrame(updateLevel);
    };
    updateLevel();
  }

  muteChannelPlayback(channelName) {
    this.mutedTxChannels.add(channelName);
    if (this.channelGainNodes[channelName]) {
      this.channelGainNodes[channelName].gain.value = 0;
    }
  }

  unmuteChannelPlayback(channelName) {
    this.mutedTxChannels.delete(channelName);
    if (this.channelGainNodes[channelName]) {
      this.channelGainNodes[channelName].gain.value = 1;
    }
  }

  muteChannelsForTx(channelNames) {
    for (const channelName of channelNames) {
      this.muteChannelPlayback(channelName);
    }
  }

  unmuteChannelsForTx(channelNames) {
    for (const channelName of channelNames) {
      this.unmuteChannelPlayback(channelName);
    }
  }

  isChannelBusy(channelName) {
    const room = this.rooms[channelName];
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
    for (const channelName of channelNames) {
      if (this.isChannelBusy(channelName)) {
        return true;
      }
    }
    return false;
  }

  handleTrackUnsubscribed(channelName, track, participant) {
    if (this.levelAnimations[channelName]) {
      cancelAnimationFrame(this.levelAnimations[channelName]);
      delete this.levelAnimations[channelName];
    }
    
    if (this.onLevelUpdate) {
      this.onLevelUpdate(channelName, 0);
    }
    
    track.detach().forEach((el) => {
      connectedAudioElements.delete(el);
      el.remove();
    });
  }

  async initPersistentMic() {
    if (this.txGraph) {
      console.log('[LiveKit] Persistent mic already initialized');
      return this.txGraph;
    }
    
    console.log('[LiveKit] Initializing persistent microphone');
    const ctx = this.getAudioContext();
    
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    
    console.log('[LiveKit] Persistent mic acquired, track ID:', stream.getAudioTracks()[0]?.id);
    
    const micSource = ctx.createMediaStreamSource(stream);
    const micGain = ctx.createGain();
    micGain.gain.value = 1.0;
    
    const toneGain = ctx.createGain();
    toneGain.gain.value = 1.0;
    
    const destination = ctx.createMediaStreamDestination();
    
    micSource.connect(micGain);
    micGain.connect(destination);
    toneGain.connect(destination);
    
    this.txGraph = {
      ctx,
      micStream: stream,
      micSource,
      micGain,
      toneGain,
      destination,
      outputStream: destination.stream,
    };
    
    console.log('[LiveKit] Persistent mic initialized successfully');
    return this.txGraph;
  }

  async createTxGraph() {
    if (this.txGraph) {
      const sourceTrack = this.txGraph.outputStream.getAudioTracks()[0];
      if (sourceTrack && sourceTrack.readyState !== 'ended') {
        console.log('[LiveKit] Reusing existing TX graph');
        return this.txGraph;
      }
      console.log('[LiveKit] Existing TX graph has ended track, recreating');
      this.destroyTxGraph();
    }
    
    return this.initPersistentMic();
  }

  getTxContext() {
    if (this.txGraph) {
      return this.txGraph.ctx;
    }
    return null;
  }

  getToneDestination() {
    if (this.txGraph) {
      return this.txGraph.toneGain;
    }
    return null;
  }

  async publishAudio(channelName) {
    const room = this.rooms[channelName];
    if (!room) return null;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const audioTrack = stream.getAudioTracks()[0];
    
    await room.localParticipant.publishTrack(audioTrack, {
      name: 'microphone',
      source: Track.Source.Microphone,
    });

    return { track: audioTrack, stream };
  }

  async publishAudioToChannels(channelNames) {
    console.log('[LiveKit] PTT DOWN - publishing to channels:', channelNames);
    
    if (!this.txGraph) {
      await this.createTxGraph();
    }
    
    const { outputStream } = this.txGraph;
    const sourceTrack = outputStream.getAudioTracks()[0];
    
    if (sourceTrack.readyState === 'ended') {
      console.log('[LiveKit] Source track ended, recreating TX graph');
      this.destroyTxGraph();
      await this.createTxGraph();
    }
    
    const publishedChannels = [];
    
    for (const channelName of channelNames) {
      const room = this.rooms[channelName];
      if (!room) continue;
      
      if (this.publishedTracks[channelName]) {
        console.log(`[LiveKit] Already published to ${channelName}`);
        publishedChannels.push(channelName);
        continue;
      }
      
      try {
        const clonedTrack = this.txGraph.outputStream.getAudioTracks()[0].clone();
        console.log(`[LiveKit] Publishing cloned track to ${channelName}, track ID:`, clonedTrack.id);
        
        await room.localParticipant.publishTrack(clonedTrack, {
          name: 'dispatch-audio',
          source: Track.Source.Microphone,
        });
        
        this.publishedTracks[channelName] = clonedTrack;
        publishedChannels.push(channelName);
        console.log(`[LiveKit] Successfully published to ${channelName}`);
      } catch (err) {
        console.error(`[LiveKit] Failed to publish to ${channelName}:`, err);
      }
    }
    
    console.log('[LiveKit] Active published tracks:', Object.keys(this.publishedTracks));
    return publishedChannels;
  }

  async unpublishAudioFromChannels(channelNames) {
    const channelsToUnpublish = channelNames || Object.keys(this.publishedTracks);
    console.log('[LiveKit] PTT UP - unpublishing from channels:', channelsToUnpublish);
    
    for (const channelName of channelsToUnpublish) {
      const room = this.rooms[channelName];
      const track = this.publishedTracks[channelName];
      
      if (!room || !track) continue;
      
      try {
        console.log(`[LiveKit] Unpublishing track from ${channelName}, track ID:`, track.id);
        await room.localParticipant.unpublishTrack(track);
        
        if (typeof track.enabled !== 'undefined') {
          track.enabled = false;
          console.log(`[LiveKit] Disabled track on ${channelName}`);
        }
        
        track.stop();
        console.log(`[LiveKit] Stopped track on ${channelName}, readyState:`, track.readyState);
        
        delete this.publishedTracks[channelName];
      } catch (err) {
        console.error(`[LiveKit] Failed to unpublish from ${channelName}:`, err);
        try {
          track.enabled = false;
          track.stop();
        } catch (e) {}
        delete this.publishedTracks[channelName];
      }
    }
    
    console.log('[LiveKit] Active published tracks after unpublish:', Object.keys(this.publishedTracks));
  }

  destroyTxGraph() {
    if (!this.txGraph) return;
    
    console.log('[LiveKit] Destroying TX graph');
    
    const { micStream, micSource, micGain, toneGain, destination } = this.txGraph;
    
    for (const track of Object.values(this.publishedTracks)) {
      try {
        track.stop();
        console.log('[LiveKit] Stopped orphaned published track');
      } catch (e) {}
    }
    this.publishedTracks = {};
    
    try {
      micSource.disconnect();
      console.log('[LiveKit] Disconnected micSource');
    } catch (e) {}
    
    try {
      micGain.disconnect();
      console.log('[LiveKit] Disconnected micGain');
    } catch (e) {}
    
    try {
      toneGain.disconnect();
      console.log('[LiveKit] Disconnected toneGain');
    } catch (e) {}
    
    if (destination && destination.stream) {
      destination.stream.getTracks().forEach(track => {
        track.stop();
        console.log('[LiveKit] Stopped destination stream track');
      });
    }
    
    if (micStream) {
      micStream.getTracks().forEach(track => {
        track.stop();
        console.log('[LiveKit] Stopped mic stream track, readyState:', track.readyState);
      });
    }
    
    this.txGraph = null;
    console.log('[LiveKit] TX graph destroyed');
  }

  async unpublishAudio(channelName, audioTrack, stream) {
    const room = this.rooms[channelName];
    if (!room) return;

    if (audioTrack) {
      await room.localParticipant.unpublishTrack(audioTrack);
      audioTrack.stop();
    }

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
  }

  sendData(channelName, message) {
    const room = this.rooms[channelName];
    if (!room) return;

    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(message));
    room.localParticipant.publishData(data, DataPacket_Kind.RELIABLE);
  }

  async disconnectChannel(channelName) {
    const room = this.rooms[channelName];
    if (!room) return;

    if (this.levelAnimations[channelName]) {
      cancelAnimationFrame(this.levelAnimations[channelName]);
      delete this.levelAnimations[channelName];
    }

    if (this.publishedTracks[channelName]) {
      try {
        this.publishedTracks[channelName].stop();
      } catch (e) {}
      delete this.publishedTracks[channelName];
    }

    await room.disconnect();
    delete this.rooms[channelName];
  }

  async disconnectAll() {
    Object.values(this.levelAnimations).forEach(id => cancelAnimationFrame(id));
    this.levelAnimations = {};
    
    this.destroyTxGraph();
    
    for (const channelName of Object.keys(this.rooms)) {
      await this.rooms[channelName].disconnect();
    }
    this.rooms = {};

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  getRoom(channelName) {
    return this.rooms[channelName];
  }

  isConnected(channelName) {
    return !!this.rooms[channelName];
  }

  getConnectedChannels() {
    return Object.keys(this.rooms);
  }
}

export const livekitEngine = new LiveKitEngine();
export default livekitEngine;
