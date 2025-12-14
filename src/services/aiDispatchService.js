import { Room, RoomEvent, TrackKind, AudioFrame, AudioSource, LocalAudioTrack, AudioStream, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { createLiveKitToken, getLiveKitUrl } from '../config/livekit.js';
import { speechToText, textToSpeech, isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { matchCommand } from './commandMatcher.js';
import { isAiDispatchEnabled } from '../db/index.js';

const AI_IDENTITY = 'AI-Dispatcher';
const LIVEKIT_SAMPLE_RATE = 48000;
const AZURE_SAMPLE_RATE = 24000;
const CHANNELS = 1;
const SAMPLES_PER_CHANNEL = 480;

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
    this.rooms = new Map();
    this.audioBuffers = new Map();
    this.isRunning = false;
    this.isMuted = false;
  }

  async start(channelNames) {
    if (!isAzureConfigured()) {
      console.log('AI Dispatcher: Azure Speech not configured, skipping start');
      return;
    }

    const enabled = await isAiDispatchEnabled();
    if (!enabled) {
      console.log('AI Dispatcher: Disabled in settings');
      return;
    }

    console.log(`AI Dispatcher: Starting for channels: ${channelNames.join(', ')}`);
    this.isRunning = true;
    this.isMuted = false;

    for (const channelName of channelNames) {
      try {
        await this.joinRoom(channelName);
      } catch (error) {
        console.error(`AI Dispatcher: Failed to join ${channelName}:`, error.message);
      }
    }

    if (this.rooms.size === 0) {
      console.error('AI Dispatcher: Failed to join any rooms, stopping');
      this.isMuted = true;
      await this.stop();
    }
  }

  async stop() {
    console.log('AI Dispatcher: Stopping...');
    this.isRunning = false;

    for (const [roomName, room] of this.rooms) {
      try {
        await room.disconnect();
        console.log(`AI Dispatcher: Left room ${roomName}`);
      } catch (error) {
        console.error(`AI Dispatcher: Error leaving ${roomName}:`, error.message);
      }
    }

    this.rooms.clear();
    this.audioBuffers.clear();
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
    
    room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
      if (track.kind === TrackKind.KIND_AUDIO && participant.identity !== AI_IDENTITY) {
        console.log(`AI Dispatcher: Audio track from ${participant.identity} in ${roomName}`);
        await this.handleAudioTrack(track, participant.identity, roomName, room);
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log(`AI Dispatcher: Disconnected from ${roomName}`);
      this.rooms.delete(roomName);
    });

    await room.connect(url, token);
    this.rooms.set(roomName, room);
    console.log(`AI Dispatcher: Joined room ${roomName}`);
  }

  async handleAudioTrack(track, participantId, roomName, room) {
    const chunks = [];
    let frameCount = 0;
    const MIN_AUDIO_BYTES = LIVEKIT_SAMPLE_RATE * 2 * 0.5;
    let trackEnded = false;

    const trackEndPromise = new Promise((resolve) => {
      const onTrackUnsubscribed = (unsubTrack, publication, participant) => {
        if (unsubTrack === track) {
          console.log(`AI Dispatcher: Track unsubscribed from ${participant.identity} in ${roomName}`);
          trackEnded = true;
          room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
          resolve();
        }
      };
      room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    });

    const audioStream = new AudioStream(track, LIVEKIT_SAMPLE_RATE, CHANNELS);
    console.log(`AI Dispatcher: Buffering transmission from ${participantId} in ${roomName}...`);

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
        console.log(`AI Dispatcher: Stream error: ${error.message}`);
      }
    };

    await Promise.race([bufferAudio(), trackEndPromise]);

    if (!this.isRunning) {
      console.log(`AI Dispatcher: Stopped during buffering, discarding`);
      return;
    }

    if (chunks.length === 0) {
      console.log(`AI Dispatcher: No audio received from ${participantId}`);
      return;
    }

    const audioBuffer = Buffer.concat(chunks);
    console.log(`AI Dispatcher: Transmission complete from ${participantId} - ${frameCount} frames, ${audioBuffer.length} bytes`);

    if (audioBuffer.length < MIN_AUDIO_BYTES) {
      console.log(`AI Dispatcher: Transmission too short (${audioBuffer.length} bytes), skipping`);
      return;
    }

    const enabled = await isAiDispatchEnabled();
    if (enabled && this.isRunning) {
      await this.processAudio(audioBuffer, roomName, room);
    }
  }

  async shouldRespond() {
    if (this.isMuted) {
      return false;
    }
    if (!this.isRunning) {
      return false;
    }
    try {
      const enabled = await isAiDispatchEnabled();
      return enabled;
    } catch (error) {
      console.error('AI Dispatcher: Error checking toggle, muting:', error.message);
      this.isMuted = true;
      return false;
    }
  }

  async processAudio(audioBuffer, roomName, room) {
    try {
      if (!await this.shouldRespond()) {
        console.log('AI Dispatcher: Disabled or muted, skipping processing');
        return;
      }

      console.log(`AI Dispatcher: Processing ${audioBuffer.length} bytes from ${roomName}`);

      const resampledAudio = resampleAudio(audioBuffer, LIVEKIT_SAMPLE_RATE, AZURE_SAMPLE_RATE);
      console.log(`AI Dispatcher: Resampled to ${resampledAudio.length} bytes at ${AZURE_SAMPLE_RATE}Hz`);

      const transcript = await speechToText(resampledAudio);
      if (!transcript) {
        console.log('AI Dispatcher: No speech detected');
        return;
      }

      console.log(`AI Dispatcher: Transcript: "${transcript}"`);

      const response = matchCommand(transcript);
      if (!response) {
        console.log('AI Dispatcher: No matching command');
        return;
      }

      console.log(`AI Dispatcher: Matched command, responding: "${response}"`);

      if (!await this.shouldRespond()) {
        console.log('AI Dispatcher: Disabled before TTS, aborting');
        return;
      }

      const responseAudio = await textToSpeech(response);

      if (!await this.shouldRespond()) {
        console.log('AI Dispatcher: Disabled before publish, aborting');
        return;
      }

      await this.publishAudio(responseAudio, room);

    } catch (error) {
      console.error('AI Dispatcher: Error processing audio, muting:', error.message);
      this.isMuted = true;
      await this.stop();
    }
  }

  async publishAudio(audioBuffer, room) {
    try {
      if (!await this.shouldRespond()) {
        console.log('AI Dispatcher: Disabled, not publishing');
        return;
      }

      const audioSource = new AudioSource(AZURE_SAMPLE_RATE, CHANNELS);
      const track = LocalAudioTrack.createAudioTrack('ai-response', audioSource);
      
      const publishOptions = new TrackPublishOptions();
      publishOptions.source = TrackSource.SOURCE_MICROPHONE;
      
      const publication = await room.localParticipant.publishTrack(track, publishOptions);

      const samples = new Int16Array(audioBuffer.buffer);
      const framesCount = Math.ceil(samples.length / SAMPLES_PER_CHANNEL);

      for (let i = 0; i < framesCount; i++) {
        if (!await this.shouldRespond()) {
          console.log('AI Dispatcher: Disabled mid-publish, stopping');
          await room.localParticipant.unpublishTrack(publication.sid);
          return;
        }

        const start = i * SAMPLES_PER_CHANNEL;
        const end = Math.min(start + SAMPLES_PER_CHANNEL, samples.length);
        const frameData = samples.slice(start, end);

        const frame = new AudioFrame(
          Buffer.from(frameData.buffer),
          AZURE_SAMPLE_RATE,
          CHANNELS,
          frameData.length
        );

        await audioSource.captureFrame(frame);
        await new Promise(resolve => setTimeout(resolve, 30));
      }

      await new Promise(resolve => setTimeout(resolve, 500));
      await room.localParticipant.unpublishTrack(publication.sid);

      console.log('AI Dispatcher: Published response audio');
    } catch (error) {
      console.error('AI Dispatcher: Error publishing audio, muting:', error.message);
      this.isMuted = true;
      await this.stop();
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

export async function startDispatcher(channelNames) {
  const dispatcher = getDispatcher();
  await dispatcher.start(channelNames);
}

export async function stopDispatcher() {
  const dispatcher = getDispatcher();
  await dispatcher.stop();
}

export async function restartDispatcher(channelNames) {
  await stopDispatcher();
  await startDispatcher(channelNames);
}
