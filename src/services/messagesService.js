import { createChannelMessage, getChannelMessages, updateMessageTranscription, getMessageById } from '../db/index.js';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { config } from '../config/env.js';
import { broadcastMessage } from './aiDispatchService.js';
import fs from 'fs';
import path from 'path';

const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

export async function sendTextMessage(channel, sender, content) {
  const message = await createChannelMessage(channel, sender, 'text', content);
  
  broadcastMessage(channel, message).catch(err => {
    console.warn('[MessagesService] Failed to broadcast text message:', err.message);
  });
  
  return message;
}

export async function sendAudioMessage(channel, sender, audioBuffer, duration = null, skipBroadcast = false) {
  const filename = `${channel}_${Date.now()}_${sender.replace(/[^a-zA-Z0-9]/g, '_')}.wav`;
  const filepath = path.join(AUDIO_DIR, filename);
  
  fs.writeFileSync(filepath, audioBuffer);
  
  const audioUrl = `/api/messages/audio/${filename}`;
  
  const message = await createChannelMessage(channel, sender, 'audio', null, audioUrl, duration);
  
  if (!skipBroadcast) {
    broadcastMessage(channel, message).catch(err => {
      console.warn('[MessagesService] Failed to broadcast audio message:', err.message);
    });
  }
  
  return message;
}

export async function getMessages(channel, limit = 50, offset = 0) {
  return await getChannelMessages(channel, limit, offset);
}

export async function transcribeMessage(messageId) {
  const message = await getMessageById(messageId);
  
  if (!message) {
    throw new Error('Message not found');
  }
  
  if (message.message_type !== 'audio') {
    throw new Error('Only audio messages can be transcribed');
  }
  
  if (message.transcription) {
    return message;
  }
  
  const filename = message.audio_url.split('/').pop();
  const filepath = path.join(AUDIO_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    throw new Error('Audio file not found');
  }
  
  const transcription = await transcribeAudioFile(filepath);
  
  return await updateMessageTranscription(messageId, transcription);
}

async function transcribeAudioFile(filepath) {
  const speechKey = config.azureSpeechKey;
  const speechRegion = config.azureSpeechRegion;
  
  if (!speechKey || !speechRegion) {
    throw new Error('Azure Speech credentials not configured');
  }
  
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechRecognitionLanguage = 'en-US';
    
    const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(filepath));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    
    let fullText = '';
    
    recognizer.recognizing = (s, e) => {};
    
    recognizer.recognized = (s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
        fullText += e.result.text + ' ';
      }
    };
    
    recognizer.canceled = (s, e) => {
      recognizer.stopContinuousRecognitionAsync();
      if (e.reason === sdk.CancellationReason.Error) {
        reject(new Error(`Transcription error: ${e.errorDetails}`));
      }
    };
    
    recognizer.sessionStopped = (s, e) => {
      recognizer.stopContinuousRecognitionAsync();
      resolve(fullText.trim() || '(No speech detected)');
    };
    
    recognizer.startContinuousRecognitionAsync(
      () => {},
      (err) => reject(new Error(`Failed to start recognition: ${err}`))
    );
  });
}

export function getAudioFilePath(filename) {
  const filepath = path.join(AUDIO_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return null;
  }
  return filepath;
}
