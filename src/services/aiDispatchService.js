import { Room, RoomEvent, TrackKind, AudioFrame, AudioSource, LocalAudioTrack, AudioStream, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { createLiveKitToken, getLiveKitUrl } from '../config/livekit.js';
import { speechToText, textToSpeech, isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { matchCommand, resetDispatcherState } from './commandMatcher.js';
import { isAiDispatchEnabled, getAiDispatchChannel } from '../db/index.js';

const AI_IDENTITY = 'AI-Dispatcher';
const LIVEKIT_SAMPLE_RATE = 48000;
const AZURE_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const SAMPLES_PER_FRAME = 960; // 60ms frames at 16kHz for smoother playback
const FRAME_DURATION_MS = Math.floor((SAMPLES_PER_FRAME / AZURE_SAMPLE_RATE) * 1000);
const DISCONNECT_GRACE_PERIOD_MS = 30000;

function resampleAudio(inputBuffer, fromRate, toRate) {
  const inputSamples = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(inputSamples.length / ratio);
  const outputSamples = new Int16Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    const nextIndex = Math.min(srcIndex + 1, inputSamples.length - 1);
    const frac = (i * ratio) - srcIndex;
    outputSamples[i] = Math.round(inputSamples[srcIndex] * (1 - frac) + inputSamples[nextIndex] * frac);
  }
  
  return Buffer.from(outputSamples.buffer);
}

class AIDispatcher {
  constructor() {
    this.room = null;
    this.roomName = null;
    this.isRunning = false;
    this.isMuted = false;
    this.humanParticipantCount = 0;
    this.disconnectTimer = null;
    this.configuredChannel = null;
  }

  log(action, details = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[AI-Dispatcher] ${timestamp} | ${action}`, JSON.stringify(details));
  }

  async start(channelName) {
    if (!channelName) {
      this.log('START_SKIPPED', { reason: 'No channel configured' });
      return;
    }

    if (!isAzureConfigured()) {
      this.log('START_SKIPPED', { reason: 'Azure Speech not configured' });
      return;
    }

    const enabled = await isAiDispatchEnabled();
    if (!enabled) {
      this.log('START_SKIPPED', { reason: 'AI Dispatch disabled in settings' });
      return;
    }

    if (this.room) {
      this.log('CHANNEL_SWITCH', { from: this.roomName, to: channelName });
      await this.leaveCurrentRoom();
    }

    this.configuredChannel = channelName;
    this.log('STARTING', { channel: channelName });
    this.isRunning = true;
    this.isMuted = false;

    try {
      await this.joinRoom(channelName);
    } catch (error) {
      this.log('START_FAILED', { channel: channelName, error: error.message });
      this.isMuted = true;
      await this.stop();
    }
  }

  async leaveCurrentRoom() {
    this.clearDisconnectTimer();
    
    if (this.room) {
      try {
        await this.room.disconnect();
        this.log('ROOM_LEFT', { room: this.roomName });
      } catch (error) {
        this.log('ROOM_LEAVE_ERROR', { room: this.roomName, error: error.message });
      }
      this.room = null;
      this.roomName = null;
      this.humanParticipantCount = 0;
    }
  }

  async stop() {
    this.log('STOPPING', { room: this.roomName });
    this.isRunning = false;
    this.clearDisconnectTimer();
    resetDispatcherState();

    if (this.room) {
      try {
        await this.room.disconnect();
        this.log('ROOM_LEFT', { room: this.roomName });
      } catch (error) {
        this.log('ROOM_LEAVE_ERROR', { room: this.roomName, error: error.message });
      }
      this.room = null;
      this.roomName = null;
    }

    this.humanParticipantCount = 0;
  }

  clearDisconnectTimer() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      this.log('DISCONNECT_TIMER_CLEARED');
    }
  }

  startDisconnectTimer() {
    this.clearDisconnectTimer();
    this.log('DISCONNECT_TIMER_STARTED', { graceMs: DISCONNECT_GRACE_PERIOD_MS });
    
    this.disconnectTimer = setTimeout(async () => {
      if (this.humanParticipantCount === 0 && this.room) {
        this.log('DISCONNECT_TIMER_EXPIRED', { reason: 'No humans in room' });
        await this.leaveRoom();
      }
    }, DISCONNECT_GRACE_PERIOD_MS);
  }

  async leaveRoom() {
    if (!this.room) return;
    
    this.log('ROOM_LEAVING', { room: this.roomName, reason: 'No humans present' });
    
    try {
      await this.room.disconnect();
      this.log('ROOM_LEFT', { room: this.roomName });
    } catch (error) {
      this.log('ROOM_LEAVE_ERROR', { room: this.roomName, error: error.message });
    }
    
    this.room = null;
    this.roomName = null;
    this.humanParticipantCount = 0;
  }

  async rejoinIfNeeded() {
    if (this.room || !this.isRunning || !this.configuredChannel) {
      return;
    }

    const enabled = await isAiDispatchEnabled();
    if (!enabled) {
      return;
    }

    this.log('REJOIN_TRIGGERED', { channel: this.configuredChannel });
    await this.joinRoom(this.configuredChannel);
  }

  isHumanParticipant(identity) {
    if (!identity) return false;
    if (identity === AI_IDENTITY) return false;
    if (identity.startsWith('AI-')) return false;
    if (identity.startsWith('SIP-')) return false;
    if (identity.startsWith('sip_')) return false;
    if (identity.startsWith('Bot-')) return false;
    if (identity.startsWith('bot_')) return false;
    if (identity.startsWith('PIPELINE_')) return false;
    if (identity.startsWith('pipeline-')) return false;
    return true;
  }

  countHumanParticipants(room) {
    let count = 0;
    for (const [, participant] of room.remoteParticipants) {
      if (this.isHumanParticipant(participant.identity)) {
        count++;
      }
    }
    return count;
  }

  async joinRoom(roomName) {
    const url = getLiveKitUrl();
    if (!url) {
      throw new Error('LiveKit URL not configured');
    }

    const token = await createLiveKitToken(AI_IDENTITY, roomName, {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const room = new Room();
    
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (this.isHumanParticipant(participant.identity)) {
        this.humanParticipantCount++;
        this.log('PARTICIPANT_JOINED', { 
          identity: participant.identity, 
          room: roomName,
          humanCount: this.humanParticipantCount 
        });
        this.clearDisconnectTimer();
      } else {
        this.log('NON_HUMAN_JOINED', { identity: participant.identity, room: roomName });
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (this.isHumanParticipant(participant.identity)) {
        this.humanParticipantCount = Math.max(0, this.humanParticipantCount - 1);
        this.log('PARTICIPANT_LEFT', { 
          identity: participant.identity, 
          room: roomName,
          humanCount: this.humanParticipantCount 
        });
        
        if (this.humanParticipantCount === 0) {
          this.startDisconnectTimer();
        }
      } else {
        this.log('NON_HUMAN_LEFT', { identity: participant.identity, room: roomName });
      }
    });

    room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
      if (track.kind === TrackKind.KIND_AUDIO && participant.identity !== AI_IDENTITY) {
        this.log('TRACK_SUBSCRIBED', { 
          participant: participant.identity, 
          room: roomName,
          trackSid: publication.sid 
        });
        await this.handleAudioTrack(track, participant.identity, roomName, room);
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      this.log('ROOM_DISCONNECTED', { room: roomName });
      this.room = null;
      this.roomName = null;
      this.humanParticipantCount = 0;
    });

    await room.connect(url, token);
    this.room = room;
    this.roomName = roomName;
    
    this.humanParticipantCount = this.countHumanParticipants(room);
    this.log('ROOM_JOINED', { 
      room: roomName, 
      humanCount: this.humanParticipantCount 
    });

    if (this.humanParticipantCount === 0) {
      this.startDisconnectTimer();
    }
  }

  async handleAudioTrack(track, participantId, roomName, room) {
    const chunks = [];
    let frameCount = 0;
    const MIN_AUDIO_BYTES = LIVEKIT_SAMPLE_RATE * 2 * 0.5;
    let trackEnded = false;

    const trackEndPromise = new Promise((resolve) => {
      const onTrackUnsubscribed = (unsubTrack, publication, participant) => {
        if (unsubTrack === track) {
          this.log('TRACK_UNSUBSCRIBED', { 
            participant: participant.identity, 
            room: roomName 
          });
          trackEnded = true;
          room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
          resolve();
        }
      };
      room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    });

    const audioStream = new AudioStream(track, LIVEKIT_SAMPLE_RATE, CHANNELS);
    this.log('AUDIO_BUFFERING_START', { participant: participantId, room: roomName });

    const bufferAudio = async () => {
      try {
        for await (const frame of audioStream) {
          if (!this.isRunning || trackEnded) {
            break;
          }
          chunks.push(Buffer.from(frame.data.buffer));
          frameCount++;
        }
      } catch (error) {
        this.log('AUDIO_STREAM_ERROR', { error: error.message });
      }
    };

    await Promise.race([bufferAudio(), trackEndPromise]);

    if (!this.isRunning) {
      this.log('AUDIO_DISCARDED', { reason: 'Dispatcher stopped during buffering' });
      return;
    }

    if (chunks.length === 0) {
      this.log('AUDIO_EMPTY', { participant: participantId });
      return;
    }

    const audioBuffer = Buffer.concat(chunks);
    this.log('AUDIO_BUFFERING_COMPLETE', { 
      participant: participantId, 
      frames: frameCount, 
      bytes: audioBuffer.length 
    });

    if (audioBuffer.length < MIN_AUDIO_BYTES) {
      this.log('AUDIO_TOO_SHORT', { bytes: audioBuffer.length, minBytes: MIN_AUDIO_BYTES });
      return;
    }

    const enabled = await isAiDispatchEnabled();
    if (enabled && this.isRunning) {
      await this.processAudio(audioBuffer, roomName, room);
    }
  }

  async shouldRespond() {
    if (this.isMuted) return false;
    if (!this.isRunning) return false;
    try {
      return await isAiDispatchEnabled();
    } catch (error) {
      this.log('TOGGLE_CHECK_ERROR', { error: error.message });
      this.isMuted = true;
      return false;
    }
  }

  async processAudio(audioBuffer, roomName, room) {
    try {
      if (!await this.shouldRespond()) {
        this.log('PROCESS_SKIPPED', { reason: 'Disabled or muted' });
        return;
      }

      this.log('AUDIO_PROCESSING', { bytes: audioBuffer.length, room: roomName });

      const resampledAudio = resampleAudio(audioBuffer, LIVEKIT_SAMPLE_RATE, AZURE_SAMPLE_RATE);

      const transcript = await speechToText(resampledAudio);
      if (!transcript) {
        this.log('STT_NO_SPEECH');
        return;
      }

      this.log('STT_RESULT', { transcript });

      const response = matchCommand(transcript);
      if (!response) {
        this.log('COMMAND_NO_MATCH', { transcript });
        return;
      }

      this.log('COMMAND_MATCHED', { transcript, response });

      if (!await this.shouldRespond()) {
        this.log('TTS_ABORTED', { reason: 'Disabled before TTS' });
        return;
      }

      const responseAudio = await textToSpeech(response);

      if (!await this.shouldRespond()) {
        this.log('PUBLISH_ABORTED', { reason: 'Disabled before publish' });
        return;
      }

      await this.publishAudio(responseAudio, room, roomName);

    } catch (error) {
      this.log('PROCESS_ERROR', { error: error.message });
      this.isMuted = true;
      await this.stop();
    }
  }

  async publishAudio(audioBuffer, room, roomName) {
    let audioSource = null;
    let track = null;
    let publication = null;

    try {
      if (!await this.shouldRespond()) {
        this.log('PUBLISH_SKIPPED', { reason: 'Disabled' });
        return;
      }

      audioSource = new AudioSource(AZURE_SAMPLE_RATE, CHANNELS);
      track = LocalAudioTrack.createAudioTrack('ai-response', audioSource);
      
      const publishOptions = new TrackPublishOptions();
      publishOptions.source = TrackSource.SOURCE_MICROPHONE;
      
      publication = await room.localParticipant.publishTrack(track, publishOptions);
      this.log('TRACK_PUBLISHED', { room: roomName, trackSid: publication.sid });

      // Pre-buffer a few frames before starting playback for smoother audio
      const samples = new Int16Array(audioBuffer.buffer);
      const framesCount = Math.ceil(samples.length / SAMPLES_PER_FRAME);
      
      this.log('AUDIO_STREAMING', { totalSamples: samples.length, frames: framesCount, frameDurationMs: FRAME_DURATION_MS });

      // Send all frames with precise timing using a single continuous stream
      const startTime = Date.now();
      
      for (let i = 0; i < framesCount; i++) {
        // Only check enabled status every 10 frames to avoid database latency
        if (i % 10 === 0 && !this.isRunning) {
          this.log('PUBLISH_INTERRUPTED', { reason: 'Dispatcher stopped mid-publish' });
          break;
        }

        const start = i * SAMPLES_PER_FRAME;
        const end = Math.min(start + SAMPLES_PER_FRAME, samples.length);
        const frameData = samples.slice(start, end);
        
        // Pad last frame if needed
        let paddedData = frameData;
        if (frameData.length < SAMPLES_PER_FRAME) {
          paddedData = new Int16Array(SAMPLES_PER_FRAME);
          paddedData.set(frameData);
        }

        const frame = new AudioFrame(
          Buffer.from(paddedData.buffer),
          AZURE_SAMPLE_RATE,
          CHANNELS,
          SAMPLES_PER_FRAME
        );

        await audioSource.captureFrame(frame);
        
        // Calculate precise sleep time based on elapsed time to maintain accurate timing
        const expectedTime = (i + 1) * FRAME_DURATION_MS;
        const elapsed = Date.now() - startTime;
        const sleepTime = Math.max(0, expectedTime - elapsed);
        if (sleepTime > 0) {
          await new Promise(resolve => setTimeout(resolve, sleepTime));
        }
      }

      // Brief pause to allow final frames to transmit
      await new Promise(resolve => setTimeout(resolve, 200));

    } catch (error) {
      this.log('PUBLISH_ERROR', { error: error.message });
      this.isMuted = true;
    } finally {
      if (publication && room.localParticipant) {
        try {
          await room.localParticipant.unpublishTrack(publication.sid);
          this.log('TRACK_UNPUBLISHED', { room: roomName, trackSid: publication.sid });
        } catch (e) {
          this.log('TRACK_UNPUBLISH_ERROR', { error: e.message });
        }
      }
      
      if (track) {
        try {
          track.stop();
          this.log('TRACK_STOPPED', { room: roomName });
        } catch (e) {
        }
      }
      
      audioSource = null;
      track = null;
    }
  }
}

let dispatcherInstance = null;

export function getDispatcher() {
  if (!dispatcherInstance) {
    dispatcherInstance = new AIDispatcher();
  }
  return dispatcherInstance;
}

export async function startDispatcher(channelName) {
  const dispatcher = getDispatcher();
  await dispatcher.start(channelName);
}

export async function stopDispatcher() {
  const dispatcher = getDispatcher();
  await dispatcher.stop();
}

export async function restartDispatcher(channelName) {
  await stopDispatcher();
  await startDispatcher(channelName);
}
