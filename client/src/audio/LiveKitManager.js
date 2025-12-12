import { Room, RoomEvent, Track } from 'livekit-client';

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class LiveKitManager {
  constructor() {
    this.rooms = new Map();
    this.onParticipantUpdate = null;
    this.onDataMessage = null;
    this.onTrackSubscribed = null;
  }

  async connect(roomName, token, url, identity) {
    if (this.rooms.has(roomName)) {
      console.log(`[LiveKit] Already connected to ${roomName}`);
      return this.rooms.get(roomName);
    }

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      console.log(`[LiveKit] Track subscribed: ${track.kind} from ${participant.identity}`);
      if (track.kind === Track.Kind.Audio) {
        this._handleAudioTrack(track, participant, roomName);
      }
      if (this.onTrackSubscribed) {
        this.onTrackSubscribed(track, publication, participant, roomName);
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      console.log(`[LiveKit] Track unsubscribed from ${participant.identity}`);
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      console.log(`[LiveKit] Participant joined: ${participant.identity}`);
      if (this.onParticipantUpdate) {
        this.onParticipantUpdate('joined', participant, roomName);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log(`[LiveKit] Participant left: ${participant.identity}`);
      if (this.onParticipantUpdate) {
        this.onParticipantUpdate('left', participant, roomName);
      }
    });

    room.on(RoomEvent.DataReceived, (payload, participant, kind) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (this.onDataMessage) {
          this.onDataMessage(data, participant, roomName);
        }
      } catch (e) {
        console.warn('[LiveKit] Failed to parse data message');
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log(`[LiveKit] Disconnected from ${roomName}`);
      this.rooms.delete(roomName);
    });

    try {
      await room.connect(url, token);
      console.log(`[LiveKit] Connected to ${roomName} as ${identity}`);
      this.rooms.set(roomName, room);
      return room;
    } catch (err) {
      console.error(`[LiveKit] Connection error for ${roomName}:`, err);
      throw err;
    }
  }

  _handleAudioTrack(track, participant, roomName) {
    if (isIOS) {
      track.attach();
    } else {
      const audioEl = track.attach();
      audioEl.play().catch(e => console.warn('Audio autoplay blocked:', e));
    }
  }

  async disconnect(roomName) {
    const room = this.rooms.get(roomName);
    if (room) {
      await room.disconnect();
      this.rooms.delete(roomName);
      console.log(`[LiveKit] Disconnected from ${roomName}`);
    }
  }

  async disconnectAll() {
    for (const [name, room] of this.rooms) {
      try {
        await room.disconnect();
      } catch (e) {}
    }
    this.rooms.clear();
  }

  getRoom(roomName) {
    return this.rooms.get(roomName);
  }

  getAllRooms() {
    return Array.from(this.rooms.values());
  }

  async sendData(roomName, data) {
    const room = this.rooms.get(roomName);
    if (!room) return;

    const payload = new TextEncoder().encode(JSON.stringify(data));
    await room.localParticipant.publishData(payload, { reliable: true });
  }

  async broadcastData(data) {
    const payload = new TextEncoder().encode(JSON.stringify(data));
    for (const room of this.rooms.values()) {
      try {
        await room.localParticipant.publishData(payload, { reliable: true });
      } catch (e) {}
    }
  }
}

export default LiveKitManager;
