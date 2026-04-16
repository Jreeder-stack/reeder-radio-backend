import { createChannelMessage, getChannelMessages, updateMessageTranscription, getMessageById, getAudioDataById } from '../db/index.js';
import pool from '../db/index.js';
import { speechToText } from './azureSpeechService.js';
import { broadcastMessage } from './aiDispatchService.js';
import fs from 'fs';
import path from 'path';

const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

async function normalizeChannelToRoomKey(channel) {
  if (typeof channel === 'string' && channel.includes('__')) {
    return channel;
  }
  try {
    const result = await pool.query(
      `SELECT COALESCE(zone, 'Default') || '__' || name AS room_key FROM channels WHERE name = $1 LIMIT 1`,
      [channel]
    );
    if (result.rows.length > 0) {
      return result.rows[0].room_key;
    }
  } catch (err) {
    console.warn('[MessagesService] Channel normalization lookup failed:', err.message);
  }
  return channel;
}

export async function sendTextMessage(channel, sender, content) {
  const normalizedChannel = await normalizeChannelToRoomKey(channel);
  const message = await createChannelMessage(normalizedChannel, sender, 'text', content);
  
  broadcastMessage(normalizedChannel, message).catch(err => {
    console.warn('[MessagesService] Failed to broadcast text message:', err.message);
  });
  
  return message;
}

export async function sendAudioMessage(channel, sender, audioBuffer, duration = null, skipBroadcast = false) {
  const normalizedChannel = await normalizeChannelToRoomKey(channel);
  const sanitizedChannel = normalizedChannel.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const sanitizedSender = sender.replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `${sanitizedChannel}_${Date.now()}_${sanitizedSender}.wav`;
  
  const audioUrl = `/api/messages/audio/${filename}`;
  
  const message = await createChannelMessage(normalizedChannel, sender, 'audio', null, audioUrl, duration, audioBuffer);
  
  try {
    const filepath = path.join(AUDIO_DIR, filename);
    fs.writeFileSync(filepath, audioBuffer);
  } catch (err) {
    console.warn('[MessagesService] Failed to write audio file to filesystem:', err.message);
  }
  
  if (!skipBroadcast) {
    broadcastMessage(normalizedChannel, message).catch(err => {
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
  
  const audioData = await getAudioDataById(message.id);
  let audioBuffer;
  if (audioData) {
    audioBuffer = audioData;
  } else {
    const filename = message.audio_url.split('/').pop();
    const filepath = path.join(AUDIO_DIR, filename);
    if (!fs.existsSync(filepath)) {
      throw new Error('Audio file not found');
    }
    audioBuffer = fs.readFileSync(filepath);
  }
  
  const transcription = await speechToText(audioBuffer);
  
  return await updateMessageTranscription(messageId, transcription || '(No speech detected)');
}

export function getAudioFilePath(filename) {
  const filepath = path.resolve(AUDIO_DIR, filename);
  if (!filepath.startsWith(AUDIO_DIR + path.sep)) {
    return null;
  }
  if (!fs.existsSync(filepath)) {
    return null;
  }
  return filepath;
}
