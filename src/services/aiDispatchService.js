import { Room, RoomEvent, TrackKind, AudioFrame, AudioSource, LocalAudioTrack, AudioStream, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { createLiveKitToken, getLiveKitUrl } from '../config/livekit.js';
import { speechToText, textToSpeech, isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { matchCommand, resetDispatcherState, matchEmergencyResponse, matchSecureConfirmation, getUnitSessionState, setUnitSessionState, DISPATCHER_STATE } from './commandMatcher.js';
import { parsePersonDetails, parseDOB } from './phoneticParser.js';
import { isAiDispatchEnabled, getAiDispatchChannel, createChannelMessage } from '../db/index.js';
import * as cadService from './cadService.js';
import fs from 'fs';
import path from 'path';

const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function pcmToWav(pcmBuffer, sampleRate = 48000, channels = 1, bitsPerSample = 16) {
  const wavHeader = createWavHeader(pcmBuffer.length, sampleRate, channels, bitsPerSample);
  return Buffer.concat([wavHeader, pcmBuffer]);
}

const AI_IDENTITY = 'AI-Dispatcher';
const LIVEKIT_SAMPLE_RATE = 48000;
const AZURE_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const SAMPLES_PER_FRAME = 960; // 60ms frames at 16kHz for smoother playback
const FRAME_DURATION_MS = Math.floor((SAMPLES_PER_FRAME / AZURE_SAMPLE_RATE) * 1000);
const DISCONNECT_GRACE_PERIOD_MS = 30000;
const EMERGENCY_STATUS_CHECK_TIMEOUT_MS = 5000;

const EMERGENCY_ESCALATION_STATE = {
  IDLE: 'IDLE',
  FIRST_CHECK: 'FIRST_CHECK',
  SECOND_CHECK: 'SECOND_CHECK',
  NO_RESPONSE_BROADCAST: 'NO_RESPONSE_BROADCAST'
};

class EmergencyEscalationController {
  constructor(dispatcher) {
    this.dispatcher = dispatcher;
    this.activeEscalations = new Map();
    this.audioQueue = Promise.resolve();
  }

  log(action, details = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[Emergency-Escalation] ${timestamp} | ${action}`, JSON.stringify(details));
  }

  hasActiveEscalation(unitId) {
    return this.activeEscalations.has(unitId);
  }

  getEscalation(unitId) {
    return this.activeEscalations.get(unitId);
  }

  async startEscalation(unitId, channel) {
    if (this.activeEscalations.has(unitId)) {
      this.log('ESCALATION_ALREADY_ACTIVE', { unitId });
      return;
    }

    this.log('ESCALATION_STARTED', { unitId, channel });

    const escalation = {
      unitId,
      channel,
      state: EMERGENCY_ESCALATION_STATE.FIRST_CHECK,
      startTime: Date.now(),
      timer: null
    };

    this.activeEscalations.set(unitId, escalation);

    await this.performStatusCheck(unitId, 1);
  }

  async performStatusCheck(unitId, attempt) {
    const escalation = this.activeEscalations.get(unitId);
    if (!escalation) return;

    this.log('STATUS_CHECK_ATTEMPT', { unitId, attempt });

    const message = `${unitId}, status check.`;
    
    this.audioQueue = this.audioQueue.then(async () => {
      await this.dispatcher.playToneAndSpeak('A', message);
    });
    await this.audioQueue;

    escalation.timer = setTimeout(async () => {
      await this.handleTimeout(unitId, attempt);
    }, EMERGENCY_STATUS_CHECK_TIMEOUT_MS);
  }

  async handleTimeout(unitId, attempt) {
    const escalation = this.activeEscalations.get(unitId);
    if (!escalation) return;

    this.log('STATUS_CHECK_TIMEOUT', { unitId, attempt });

    if (attempt === 1) {
      escalation.state = EMERGENCY_ESCALATION_STATE.SECOND_CHECK;
      await this.performStatusCheck(unitId, 2);
    } else {
      escalation.state = EMERGENCY_ESCALATION_STATE.NO_RESPONSE_BROADCAST;
      await this.broadcastNoResponse(unitId);
    }
  }

  async broadcastNoResponse(unitId) {
    this.log('NO_RESPONSE_BROADCAST', { unitId });

    const message = `Attention all receiving units, ${unitId} pressed their emergency key with no response.`;
    
    this.audioQueue = this.audioQueue.then(async () => {
      await this.dispatcher.playToneAndSpeak('CONTINUOUS', message);
    });
    await this.audioQueue;
    
    await this.sendCadBroadcast(unitId, `EMERGENCY: ${unitId} pressed emergency key with NO RESPONSE`, 'emergency');

    // Notify the unit to clear their local emergency state
    await this.sendEmergencyAck(unitId, 'escalation_complete');
    
    this.clearEscalation(unitId);
  }
  
  async sendEmergencyAck(targetUnit, reason) {
    const escalation = this.activeEscalations.get(targetUnit);
    if (!escalation) return;
    
    // Ensure room is connected before sending
    if (!this.dispatcher.room || !this.dispatcher.room.localParticipant) {
      this.log('EMERGENCY_ACK_SKIPPED', { targetUnit, reason: 'Room not connected' });
      return;
    }
    
    try {
      const data = new TextEncoder().encode(JSON.stringify({
        type: 'emergency_ack',
        targetUnit,
        channel: escalation.channel,
        timestamp: Date.now(),
        reason
      }));
      await this.dispatcher.room.localParticipant.publishData(data, { reliable: true });
      this.log('EMERGENCY_ACK_SENT', { targetUnit, reason });
    } catch (error) {
      this.log('EMERGENCY_ACK_ERROR', { error: error.message });
    }
  }

  async sendCadBroadcast(unitId, message, priority) {
    const cadService = await import('./cadService.js');
    if (cadService.isConfigured()) {
      try {
        const result = await cadService.sendBroadcast(message, priority);
        this.log('CAD_BROADCAST_SENT', { unitId, message, priority, success: result.success });
      } catch (error) {
        this.log('CAD_BROADCAST_ERROR', { error: error.message });
      }
    }
  }

  async handleUnitResponse(unitId, responseType, details = {}) {
    const escalation = this.activeEscalations.get(unitId);
    if (!escalation) return null;

    if (escalation.timer) {
      clearTimeout(escalation.timer);
      escalation.timer = null;
    }

    this.log('UNIT_RESPONDED', { unitId, responseType, details });

    if (responseType === 'OK') {
      // Notify the unit to clear their local emergency state
      await this.sendEmergencyAck(unitId, 'acknowledged');
      
      this.clearEscalation(unitId);
      return {
        response: `${unitId}, copy. Clear emergency.`,
        clearEmergency: true
      };
    } else if (responseType === 'DISTRESS') {
      this.clearEscalation(unitId);
      const distressType = details.distressType || 'requesting backup';
      const message = `Attention all units, ${unitId} is ${distressType}.`;
      
      this.audioQueue = this.audioQueue.then(async () => {
        await this.dispatcher.playToneAndSpeak('CONTINUOUS', message);
      });
      await this.audioQueue;
      
      await this.sendCadBroadcast(unitId, `EMERGENCY: ${unitId} ${distressType}`, 'emergency');
      
      return {
        response: null,
        clearEmergency: false
      };
    }

    return null;
  }

  clearEscalation(unitId) {
    const escalation = this.activeEscalations.get(unitId);
    if (escalation) {
      if (escalation.timer) {
        clearTimeout(escalation.timer);
      }
      this.activeEscalations.delete(unitId);
      this.log('ESCALATION_CLEARED', { unitId });
    }
  }

  clearAllEscalations() {
    for (const [unitId, escalation] of this.activeEscalations) {
      if (escalation.timer) {
        clearTimeout(escalation.timer);
      }
    }
    this.activeEscalations.clear();
    this.log('ALL_ESCALATIONS_CLEARED');
  }
}

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
    this.emergencyEscalation = new EmergencyEscalationController(this);
  }

  log(action, details = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[AI-Dispatcher] ${timestamp} | ${action}`, JSON.stringify(details));
  }

  async start(channelName, options = {}) {
    const { connectImmediately = false, roomKey = null } = options;
    
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

    this.configuredChannel = roomKey || channelName;
    this.displayChannel = channelName;
    this.isRunning = true;
    this.isMuted = false;
    
    this.log('STARTED_STANDBY', { channel: channelName, roomKey: this.configuredChannel, mode: 'on-demand' });
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
    this.emergencyEscalation.clearAllEscalations();
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

    room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (participant && this.isHumanParticipant(participant.identity)) {
        this.handleDataMessage(payload, participant);
      }
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
    let lastFrameTime = Date.now();
    const IDLE_TIMEOUT_MS = 1500;
    let idleTimeoutTriggered = false;

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

    const idleTimeoutPromise = new Promise((resolve) => {
      const checkIdle = setInterval(() => {
        if (trackEnded || idleTimeoutTriggered) {
          clearInterval(checkIdle);
          return;
        }
        const timeSinceLastFrame = Date.now() - lastFrameTime;
        if (frameCount > 0 && timeSinceLastFrame > IDLE_TIMEOUT_MS) {
          this.log('AUDIO_IDLE_TIMEOUT', { 
            participant: participantId,
            timeSinceLastFrame,
            frameCount
          });
          idleTimeoutTriggered = true;
          trackEnded = true;
          clearInterval(checkIdle);
          resolve();
        }
      }, 200);
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
          lastFrameTime = Date.now();
        }
      } catch (error) {
        this.log('AUDIO_STREAM_ERROR', { error: error.message });
      }
    };

    await Promise.race([bufferAudio(), trackEndPromise, idleTimeoutPromise]);

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

    this.saveAudioAsMessage(audioBuffer, roomName, participantId);

    const enabled = await isAiDispatchEnabled();
    if (enabled && this.isRunning) {
      await this.processAudio(audioBuffer, roomName, room, participantId);
    }
  }

  async saveAudioAsMessage(audioBuffer, channelName, sender) {
    try {
      const wavBuffer = pcmToWav(audioBuffer, LIVEKIT_SAMPLE_RATE, CHANNELS, 16);
      const filename = `${channelName}_${Date.now()}_${sender.replace(/[^a-zA-Z0-9]/g, '_')}.wav`;
      const filepath = path.join(AUDIO_DIR, filename);
      
      fs.writeFileSync(filepath, wavBuffer);
      
      const audioUrl = `/api/messages/audio/${filename}`;
      const durationSecs = Math.round(audioBuffer.length / (LIVEKIT_SAMPLE_RATE * 2));
      
      const message = await createChannelMessage(channelName, sender, 'audio', null, audioUrl, durationSecs);
      this.log('VOICE_MESSAGE_SAVED', { channel: channelName, sender, filename, duration: durationSecs });
      
      if (this.room && this.roomName === channelName && this.room.localParticipant) {
        try {
          const broadcastData = new TextEncoder().encode(JSON.stringify({
            type: 'new_message',
            message: {
              id: message.id,
              channel: channelName,
              sender,
              message_type: 'audio',
              audio_url: audioUrl,
              audio_duration: durationSecs,
              created_at: message.created_at
            }
          }));
          await this.room.localParticipant.publishData(broadcastData, { reliable: true });
          this.log('MESSAGE_BROADCAST', { channel: channelName, messageId: message.id });
        } catch (broadcastErr) {
          this.log('MESSAGE_BROADCAST_ERROR', { error: broadcastErr.message });
        }
      }
    } catch (error) {
      this.log('VOICE_MESSAGE_SAVE_ERROR', { error: error.message, channel: channelName, sender });
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

  async processAudio(audioBuffer, roomName, room, participantId) {
    try {
      if (!await this.shouldRespond()) {
        this.log('PROCESS_SKIPPED', { reason: 'Disabled or muted' });
        return;
      }

      this.log('AUDIO_PROCESSING', { bytes: audioBuffer.length, room: roomName, participant: participantId });

      const resampledAudio = resampleAudio(audioBuffer, LIVEKIT_SAMPLE_RATE, AZURE_SAMPLE_RATE);

      const transcript = await speechToText(resampledAudio);
      if (!transcript) {
        this.log('STT_NO_SPEECH');
        return;
      }

      this.log('STT_RESULT', { transcript, participant: participantId });

      if (this.emergencyEscalation.hasActiveEscalation(participantId)) {
        const emergencyResponse = matchEmergencyResponse(transcript);
        if (emergencyResponse) {
          this.log('EMERGENCY_RESPONSE_DETECTED', { 
            participant: participantId, 
            responseType: emergencyResponse.type,
            distressType: emergencyResponse.distressType 
          });
          
          const result = await this.emergencyEscalation.handleUnitResponse(
            participantId, 
            emergencyResponse.type, 
            { distressType: emergencyResponse.distressType }
          );
          
          if (result && result.response) {
            const responseAudio = await textToSpeech(result.response);
            await this.publishAudio(responseAudio, room, roomName);
          }
          
          if (result && result.cadAction === 'broadcast' && result.cadData && cadService.isConfigured()) {
            try {
              await cadService.sendBroadcast(result.cadData.message, result.cadData.priority);
            } catch (cadError) {
              this.log('CAD_BROADCAST_ERROR', { error: cadError.message });
            }
          }
          
          return;
        }
      }

      const commandResult = matchCommand(transcript, participantId);
      if (!commandResult) {
        this.log('COMMAND_NO_MATCH', { transcript });
        return;
      }

      if (commandResult.intent === 'PERSON_CHECK_DETAILS') {
        await this.handlePersonCheckDetails(participantId, commandResult.rawTranscript, room, roomName);
        return;
      }

      if (commandResult.intent === 'PERSON_CHECK_DOB') {
        await this.handlePersonCheckDOB(participantId, commandResult.rawTranscript, commandResult.slots, room, roomName);
        return;
      }

      if (commandResult.intent === 'SECURE_CONFIRM_RESPONSE') {
        await this.handleSecureConfirmResponse(participantId, commandResult.rawTranscript, commandResult.slots, room, roomName);
        return;
      }

      let finalResponse = commandResult.response;
      let finalCadStatus = commandResult.cadStatus;
      let finalCadAction = commandResult.cadAction;
      let finalCadData = commandResult.cadData;

      if (commandResult.asyncCompletion) {
        try {
          const cadServiceArg = cadService.isConfigured() ? cadService : null;
          const asyncResult = await commandResult.asyncCompletion(cadServiceArg);
          if (asyncResult) {
            finalResponse = asyncResult.response;
            finalCadStatus = asyncResult.cadStatus;
            finalCadAction = asyncResult.cadAction;
            finalCadData = asyncResult.cadData;
          }
        } catch (asyncError) {
          this.log('ASYNC_COMPLETION_ERROR', { error: asyncError.message });
          finalResponse = `${commandResult.unitId}, standby. System error.`;
        }
      }

      this.log('COMMAND_MATCHED', { transcript, response: finalResponse, cadStatus: finalCadStatus, cadAction: finalCadAction });

      if (finalCadStatus && commandResult.unitId) {
        try {
          const cadResult = await cadService.updateUnitStatus(commandResult.unitId, finalCadStatus);
          this.log('CAD_STATUS_UPDATE', { 
            unitId: commandResult.unitId, 
            status: finalCadStatus, 
            success: cadResult.success,
            error: cadResult.error
          });
        } catch (cadError) {
          this.log('CAD_ERROR', { error: cadError.message });
        }
      }

      if (finalCadAction === 'broadcast' && finalCadData && cadService.isConfigured()) {
        try {
          const broadcastResult = await cadService.sendBroadcast(finalCadData.message, finalCadData.priority);
          this.log('CAD_BROADCAST', { 
            message: finalCadData.message,
            priority: finalCadData.priority,
            success: broadcastResult.success,
            error: broadcastResult.error
          });
        } catch (cadError) {
          this.log('CAD_BROADCAST_ERROR', { error: cadError.message });
        }
      }

      if (!finalResponse) {
        this.log('NO_RESPONSE_NEEDED');
        return;
      }

      if (!await this.shouldRespond()) {
        this.log('TTS_ABORTED', { reason: 'Disabled before TTS' });
        return;
      }

      const responseAudio = await textToSpeech(finalResponse);

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

  async handlePersonCheckDetails(participantId, rawTranscript, room, roomName) {
    this.log('PERSON_CHECK_DETAILS', { participant: participantId, transcript: rawTranscript });
    
    const personDetails = parsePersonDetails(rawTranscript);
    this.log('PERSON_DETAILS_PARSED', personDetails);
    
    if (!personDetails.lastName) {
      const response = `${participantId}, did not copy last name. Go ahead with last name.`;
      const responseAudio = await textToSpeech(response);
      await this.publishAudio(responseAudio, room, roomName);
      return;
    }
    
    if (!personDetails.dob) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_DOB, null, {
        lastName: personDetails.lastName,
        firstName: personDetails.firstName || 'unknown'
      });
      const response = `${participantId}, did not copy date of birth. Go ahead with date of birth.`;
      const responseAudio = await textToSpeech(response);
      await this.publishAudio(responseAudio, room, roomName);
      return;
    }
    
    const lastName = personDetails.lastName;
    const firstName = personDetails.firstName || 'unknown';
    const dob = personDetails.dob.formatted;
    
    const confirmResponse = `${participantId}, confirming. Last ${lastName}, first ${firstName}, date of birth ${dob}. Standby.`;
    const confirmAudio = await textToSpeech(confirmResponse);
    await this.publishAudio(confirmAudio, room, roomName);
    
    try {
      if (!cadService.isConfigured()) {
        const noConfigResponse = `${participantId}, CAD system not available. Standby.`;
        const noConfigAudio = await textToSpeech(noConfigResponse);
        await this.publishAudio(noConfigAudio, room, roomName);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
        return;
      }
      
      const cadResult = await cadService.queryPerson(firstName, lastName, personDetails.dob?.formatted);
      this.log('CAD_PERSON_QUERY_RESULT', { participantId, result: cadResult });
      
      if (!cadResult.success) {
        const errorResponse = `${participantId}, Central. Unable to complete records check. Try again.`;
        const errorAudio = await textToSpeech(errorResponse);
        await this.publishAudio(errorAudio, room, roomName);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
        return;
      }
      
      const hasRecord = (cadResult.count > 0) || (cadResult.results && cadResult.results.length > 0);
      const person = (cadResult.results && cadResult.results.length > 0) ? cadResult.results[0] : (cadResult.person || cadResult.data || {});
      const hasFlags = person.wanted || person.warrant || person.bolo || 
                       (person.warrants && person.warrants.length > 0) ||
                       (person.flags && person.flags.length > 0);
      
      if (hasFlags) {
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECURE_CONFIRM, null, {
          lastName,
          firstName,
          dob,
          personData: person
        });
        
        const securePrompt = `${participantId}, Central. Is your mic secure?`;
        const secureAudio = await textToSpeech(securePrompt);
        await this.publishAudio(secureAudio, room, roomName);
      } else if (hasRecord) {
        const clearResponse = `${participantId}, Central. Local file, no wants or warrants.`;
        const clearAudio = await textToSpeech(clearResponse);
        await this.publishAudio(clearAudio, room, roomName);
        
        await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dob} - Local file, no wants or warrants`);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
      } else {
        const noRecordResponse = `${participantId}, Central. No record on file.`;
        const noRecordAudio = await textToSpeech(noRecordResponse);
        await this.publishAudio(noRecordAudio, room, roomName);
        
        await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dob} - No record on file`);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
      }
      
    } catch (error) {
      this.log('PERSON_CHECK_ERROR', { error: error.message });
      const errorResponse = `${participantId}, Central. System error on records check.`;
      const errorAudio = await textToSpeech(errorResponse);
      await this.publishAudio(errorAudio, room, roomName);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
    }
  }

  async handlePersonCheckDOB(participantId, rawTranscript, savedSlots, room, roomName) {
    this.log('PERSON_CHECK_DOB', { participant: participantId, transcript: rawTranscript, savedSlots });
    
    const dob = parseDOB(rawTranscript);
    
    if (!dob) {
      const response = `${participantId}, did not copy date of birth. Go ahead with date of birth.`;
      const responseAudio = await textToSpeech(response);
      await this.publishAudio(responseAudio, room, roomName);
      return;
    }
    
    const lastName = savedSlots.lastName;
    const firstName = savedSlots.firstName || 'unknown';
    const dobFormatted = dob.formatted;
    
    const confirmResponse = `${participantId}, confirming. Last ${lastName}, first ${firstName}, date of birth ${dobFormatted}. Standby.`;
    const confirmAudio = await textToSpeech(confirmResponse);
    await this.publishAudio(confirmAudio, room, roomName);
    
    try {
      if (!cadService.isConfigured()) {
        const noConfigResponse = `${participantId}, CAD system not available. Standby.`;
        const noConfigAudio = await textToSpeech(noConfigResponse);
        await this.publishAudio(noConfigAudio, room, roomName);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
        return;
      }
      
      const cadResult = await cadService.queryPerson(firstName, lastName, dobFormatted);
      this.log('CAD_PERSON_QUERY_RESULT', { participantId, result: cadResult });
      
      if (!cadResult.success) {
        const errorResponse = `${participantId}, Central. Unable to complete records check. Try again.`;
        const errorAudio = await textToSpeech(errorResponse);
        await this.publishAudio(errorAudio, room, roomName);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
        return;
      }
      
      const hasRecord = (cadResult.count > 0) || (cadResult.results && cadResult.results.length > 0);
      const person = (cadResult.results && cadResult.results.length > 0) ? cadResult.results[0] : (cadResult.person || cadResult.data || {});
      const hasFlags = person.wanted || person.warrant || person.bolo || 
                       (person.warrants && person.warrants.length > 0) ||
                       (person.flags && person.flags.length > 0);
      
      if (hasFlags) {
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECURE_CONFIRM, null, {
          lastName,
          firstName,
          dob: dobFormatted,
          personData: person
        });
        
        const securePrompt = `${participantId}, Central. Is your mic secure?`;
        const secureAudio = await textToSpeech(securePrompt);
        await this.publishAudio(secureAudio, room, roomName);
      } else if (hasRecord) {
        const clearResponse = `${participantId}, Central. Local file, no wants or warrants.`;
        const clearAudio = await textToSpeech(clearResponse);
        await this.publishAudio(clearAudio, room, roomName);
        
        await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dobFormatted} - Local file, no wants or warrants`);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
      } else {
        const noRecordResponse = `${participantId}, Central. No record on file.`;
        const noRecordAudio = await textToSpeech(noRecordResponse);
        await this.publishAudio(noRecordAudio, room, roomName);
        
        await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dobFormatted} - No record on file`);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
      }
      
    } catch (error) {
      this.log('PERSON_CHECK_DOB_ERROR', { error: error.message });
      const errorResponse = `${participantId}, Central. System error on records check.`;
      const errorAudio = await textToSpeech(errorResponse);
      await this.publishAudio(errorAudio, room, roomName);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
    }
  }

  async handleSecureConfirmResponse(participantId, rawTranscript, slots, room, roomName) {
    this.log('SECURE_CONFIRM_RESPONSE', { participant: participantId, transcript: rawTranscript, slots });
    
    const secureResult = matchSecureConfirmation(rawTranscript);
    
    if (!secureResult) {
      const repeatPrompt = `${participantId}, Central. Confirm, is your mic secure?`;
      const repeatAudio = await textToSpeech(repeatPrompt);
      await this.publishAudio(repeatAudio, room, roomName);
      return;
    }
    
    if (!secureResult.confirmed) {
      const standbyResponse = `${participantId}, Central. Copy. Contact dispatch on secure line.`;
      const standbyAudio = await textToSpeech(standbyResponse);
      await this.publishAudio(standbyAudio, room, roomName);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
      return;
    }
    
    const { lastName, firstName, dob, personData } = slots;
    
    let flagDetails = [];
    if (personData.wanted) flagDetails.push(`wanted out of ${personData.wanted_county || 'unknown county'}`);
    if (personData.warrant) flagDetails.push(`active warrant out of ${personData.warrant_county || 'unknown county'}`);
    if (personData.warrants && personData.warrants.length > 0) {
      personData.warrants.forEach(w => {
        flagDetails.push(`${w.type || 'warrant'} out of ${w.county || 'unknown county'}`);
      });
    }
    if (personData.bolo) flagDetails.push('active BOLO');
    if (personData.flags && personData.flags.length > 0) {
      personData.flags.forEach(f => flagDetails.push(f.description || f.type || 'flag on file'));
    }
    
    const flagText = flagDetails.length > 0 ? flagDetails.join(', ') : 'flag on file';
    const flagResponse = `${participantId}, Central. ${lastName}, ${firstName}, date of birth ${dob} returns ${flagText}. Use caution.`;
    const flagAudio = await textToSpeech(flagResponse);
    await this.publishAudio(flagAudio, room, roomName);
    
    await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dob} - ${flagText}`);
    
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
  }

  async logToCallNotes(unitId, note) {
    try {
      if (!cadService.isConfigured()) return;
      
      const statusCheck = await cadService.getStatusCheck();
      if (statusCheck.success && statusCheck.units) {
        const unitData = statusCheck.units.find(u => u.unit_id === unitId || u.id === unitId);
        if (unitData && unitData.call_id) {
          await cadService.addCallNote(unitData.call_id, note);
          this.log('CALL_NOTE_ADDED', { unitId, callId: unitData.call_id, note });
        }
      }
    } catch (error) {
      this.log('CALL_NOTE_ERROR', { error: error.message });
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

      // Wait for clients to subscribe before sending audio
      await new Promise(resolve => setTimeout(resolve, 300));

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

      const TRAILING_SILENT_FRAMES = 4;
      for (let s = 0; s < TRAILING_SILENT_FRAMES; s++) {
        const silentFrame = new AudioFrame(
          Buffer.alloc(SAMPLES_PER_FRAME * 2),
          AZURE_SAMPLE_RATE,
          CHANNELS,
          SAMPLES_PER_FRAME
        );
        await audioSource.captureFrame(silentFrame);
        await new Promise(resolve => setTimeout(resolve, FRAME_DURATION_MS));
      }

      await new Promise(resolve => setTimeout(resolve, 800));

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

  generateTone(toneType, durationMs) {
    const sampleRate = AZURE_SAMPLE_RATE;
    const numSamples = Math.floor((durationMs / 1000) * sampleRate);
    const samples = new Int16Array(numSamples);
    
    if (toneType === 'A') {
      const frequency = 1200;
      const amplitude = 0.5 * 32767;
      for (let i = 0; i < numSamples; i++) {
        samples[i] = Math.floor(Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude);
      }
    } else if (toneType === 'CONTINUOUS') {
      const freq1 = 800;
      const freq2 = 850;
      const lfoFreq = 8;
      for (let i = 0; i < numSamples; i++) {
        const lfo = 0.6 + 0.3 * (Math.sin(2 * Math.PI * lfoFreq * i / sampleRate) > 0 ? 1 : 0);
        const wave1 = (2 * ((freq1 * i / sampleRate) % 1) - 1);
        const wave2 = (Math.sin(2 * Math.PI * freq2 * i / sampleRate) > 0 ? 1 : -1);
        samples[i] = Math.floor((wave1 + wave2) * 0.3 * lfo * 32767);
      }
    }
    
    return Buffer.from(samples.buffer);
  }

  async sendDataMessage(messageObj) {
    if (!this.room) return;
    try {
      const data = new TextEncoder().encode(JSON.stringify(messageObj));
      await this.room.localParticipant.publishData(data, { reliable: true });
      this.log('DATA_MESSAGE_SENT', messageObj);
    } catch (error) {
      this.log('DATA_MESSAGE_SEND_ERROR', { error: error.message });
    }
  }

  async playToneAndSpeak(toneType, message) {
    if (!this.room || !this.isRunning) {
      this.log('TONE_SPEAK_SKIPPED', { reason: 'Not connected or not running' });
      return;
    }

    this.log('TONE_SPEAK_START', { toneType, message });

    try {
      // Signal clients to release PTT so they can hear the AI
      await this.sendDataMessage({ type: 'ai-playback-start' });
      
      // Small delay to let clients process the signal
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const toneDuration = toneType === 'CONTINUOUS' ? 3000 : 2500;
      const toneAudio = this.generateTone(toneType, toneDuration);
      
      await this.publishAudio(toneAudio, this.room, this.roomName);
      
      await new Promise(resolve => setTimeout(resolve, 300));
      
      if (message) {
        const speechAudio = await textToSpeech(message);
        await this.publishAudio(speechAudio, this.room, this.roomName);
      }
      
      // Small delay after audio completes
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Signal clients that AI playback is done
      await this.sendDataMessage({ type: 'ai-playback-end' });
      
      this.log('TONE_SPEAK_COMPLETE', { toneType, message });
    } catch (error) {
      this.log('TONE_SPEAK_ERROR', { error: error.message });
      // Still send end signal on error
      await this.sendDataMessage({ type: 'ai-playback-end' });
    }
  }

  handleDataMessage(data, participant) {
    try {
      let jsonStr;
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        jsonStr = new TextDecoder().decode(data);
      } else if (typeof data === 'string') {
        jsonStr = data;
      } else {
        jsonStr = data.toString();
      }
      
      this.log('DATA_MESSAGE_RAW', { raw: jsonStr.substring(0, 200), participant: participant?.identity });
      
      const message = JSON.parse(jsonStr);
      
      if (message.type === 'heartbeat' && message.location) {
        const unitId = message.identity || participant?.identity;
        const { lat, lng, accuracy } = message.location;
        if (unitId && typeof lat === 'number' && typeof lng === 'number') {
          import('../services/locationService.js').then(mod => {
            mod.default.updateLocation(unitId, lat, lng, accuracy, message.channel);
          });
        }
      } else if (message.type === 'emergency' && message.active === true) {
        const unitId = participant.identity;
        this.log('EMERGENCY_BUTTON_PRESSED', { unitId, channel: this.roomName });
        
        this.emergencyEscalation.startEscalation(unitId, this.roomName);
      } else if (message.type === 'emergency' && message.active === false) {
        const unitId = participant.identity;
        this.log('EMERGENCY_BUTTON_CLEARED', { unitId });
        
        this.emergencyEscalation.clearEscalation(unitId);
      }
    } catch (error) {
      this.log('DATA_MESSAGE_PARSE_ERROR', { error: error.message });
    }
  }
}

let dispatcherInstance = null;
let signalingUnsubscribers = [];

export function getDispatcher() {
  if (!dispatcherInstance) {
    dispatcherInstance = new AIDispatcher();
  }
  return dispatcherInstance;
}

async function setupSignalingIntegration(channelName) {
  try {
    const { signalingService } = await import('./signalingService.js');
    const { aiDispatcherSignaling } = await import('./aiDispatcherSignaling.js');
    
    signalingUnsubscribers.forEach(unsub => unsub());
    signalingUnsubscribers = [];
    
    const dispatcher = getDispatcher();
    aiDispatcherSignaling.initialize(dispatcher);
    aiDispatcherSignaling.setActiveChannel(channelName);
    
    signalingUnsubscribers.push(
      signalingService.onPttStart(async (data) => {
        if (data.channelId === channelName) {
          await aiDispatcherSignaling.handlePttStart(data.channelId, data.unitId, data.isEmergency);
        }
      })
    );
    
    signalingUnsubscribers.push(
      signalingService.onPttEnd(async (data) => {
        if (data.channelId === channelName) {
          await aiDispatcherSignaling.handlePttEnd(data.channelId, data.unitId, data.gracePeriodMs);
        }
      })
    );
    
    signalingUnsubscribers.push(
      signalingService.onEmergencyStart(async (data) => {
        if (data.channelId === channelName) {
          await aiDispatcherSignaling.handleEmergencyStart(data.channelId, data.unitId);
        }
      })
    );
    
    signalingUnsubscribers.push(
      signalingService.onEmergencyEnd(async (data) => {
        if (data.channelId === channelName) {
          await aiDispatcherSignaling.handleEmergencyEnd(data.channelId, data.unitId);
        }
      })
    );
    
    console.log(`[AI-Dispatcher] Signaling integration setup for channel: ${channelName}`);
  } catch (err) {
    console.error('[AI-Dispatcher] Failed to setup signaling integration:', err.message);
  }
}

export async function startDispatcher(channelName, roomKey = null) {
  const dispatcher = getDispatcher();
  const resolvedRoomKey = roomKey || channelName;
  await dispatcher.start(channelName, { roomKey: resolvedRoomKey });
  await setupSignalingIntegration(resolvedRoomKey);
}

export async function stopDispatcher() {
  const dispatcher = getDispatcher();
  
  signalingUnsubscribers.forEach(unsub => unsub());
  signalingUnsubscribers = [];
  
  try {
    const { aiDispatcherSignaling } = await import('./aiDispatcherSignaling.js');
    if (dispatcher.configuredChannel) {
      aiDispatcherSignaling.removeActiveChannel(dispatcher.configuredChannel);
    }
  } catch (err) {
    console.error('[AI-Dispatcher] Failed to cleanup signaling:', err.message);
  }
  
  await dispatcher.stop();
}

export async function restartDispatcher(channelName, roomKey = null) {
  await stopDispatcher();
  await startDispatcher(channelName, roomKey);
}

export async function broadcastMessage(channelName, message) {
  const dispatcher = getDispatcher();
  if (dispatcher.room && dispatcher.roomName === channelName && dispatcher.room.localParticipant) {
    try {
      const data = new TextEncoder().encode(JSON.stringify({
        type: 'new_message',
        message
      }));
      await dispatcher.room.localParticipant.publishData(data, { reliable: true });
      console.log(`[AI-Dispatcher] Broadcast message to ${channelName}:`, message.id);
      return true;
    } catch (error) {
      console.error(`[AI-Dispatcher] Failed to broadcast to ${channelName}:`, error.message);
      return false;
    }
  }
  console.log(`[AI-Dispatcher] Cannot broadcast to ${channelName}: dispatcher is on ${dispatcher.roomName || 'no room'}`);
  return false;
}
