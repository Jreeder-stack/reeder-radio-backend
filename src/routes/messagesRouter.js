import { Router } from 'express';
import { sendTextMessage, sendAudioMessage, getMessages, transcribeMessage, getAudioFilePath } from '../services/messagesService.js';
import { getMessagesByDateRange, getAudioDataByFilename } from '../db/index.js';
import { requireDispatcher } from '../middleware/auth.js';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';

const router = Router();

const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');

router.get('/export/audio', requireDispatcher, async (req, res) => {
  try {
    const { channel, from, to } = req.query;
    if (!channel || !from || !to) {
      return res.status(400).json({ success: false, error: 'channel, from, and to query parameters are required' });
    }

    const messages = await getMessagesByDateRange(channel, from, to, 'audio');
    if (messages.length === 0) {
      return res.status(404).json({ success: false, error: 'No audio messages found in the specified range' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${channel}_audio_export_${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    const manifest = [];

    for (const msg of messages) {
      if (!msg.audio_url) continue;
      const filename = msg.audio_url.split('/').pop();
      
      const audioData = await getAudioDataByFilename(filename);
      if (audioData) {
        archive.append(audioData, { name: filename });
        manifest.push({
          file: filename,
          sender: msg.sender,
          timestamp: msg.created_at,
          duration_ms: msg.audio_duration,
          transcription: msg.transcription || null
        });
      } else {
        const filepath = path.join(AUDIO_DIR, filename);
        if (fs.existsSync(filepath)) {
          archive.file(filepath, { name: filename });
          manifest.push({
            file: filename,
            sender: msg.sender,
            timestamp: msg.created_at,
            duration_ms: msg.audio_duration,
            transcription: msg.transcription || null
          });
        }
      }
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    await archive.finalize();
  } catch (error) {
    console.error('Error exporting audio:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

router.get('/audio/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }
    
    const audioData = await getAudioDataByFilename(filename);
    if (audioData) {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', audioData.length);
      return res.send(audioData);
    }

    let decodedFilename;
    try {
      decodedFilename = decodeURIComponent(filename);
    } catch {
      decodedFilename = filename;
    }
    const isSafeDecoded = decodedFilename !== filename
      && !decodedFilename.includes('..')
      && !decodedFilename.includes('/')
      && !decodedFilename.includes('\\');

    if (isSafeDecoded) {
      const decodedAudioData = await getAudioDataByFilename(decodedFilename);
      if (decodedAudioData) {
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', decodedAudioData.length);
        return res.send(decodedAudioData);
      }
    }

    const filepath = getAudioFilePath(filename);
    if (filepath) {
      res.setHeader('Content-Type', 'audio/wav');
      return res.sendFile(filepath);
    }

    if (isSafeDecoded) {
      const decodedFilepath = getAudioFilePath(decodedFilename);
      if (decodedFilepath) {
        res.setHeader('Content-Type', 'audio/wav');
        return res.sendFile(decodedFilepath);
      }
    }

    console.warn(`[AudioRoute] Audio file not found: filename="${filename}"${isSafeDecoded ? `, decoded="${decodedFilename}"` : ''} — no match in DB or filesystem`);
    return res.status(404).json({ success: false, error: 'Audio file not found' });
  } catch (error) {
    console.error('Error serving audio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/transcribe/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    
    const message = await transcribeMessage(parseInt(messageId));
    res.json({ success: true, message });
  } catch (error) {
    console.error('Error transcribing message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:channel', async (req, res) => {
  try {
    const { channel } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const messages = await getMessages(channel, limit, offset);
    res.json({ success: true, messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:channel/text', async (req, res) => {
  try {
    const { channel } = req.params;
    const { content } = req.body;
    const sender = req.session?.user?.unit_id || req.session?.user?.username || 'Unknown';
    
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'Message content is required' });
    }
    
    const message = await sendTextMessage(channel, sender, content.trim());
    res.json({ success: true, message });
  } catch (error) {
    console.error('Error sending text message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:channel/audio', async (req, res) => {
  try {
    const { channel } = req.params;
    const sender = req.body.sender || req.session?.user?.unit_id || req.session?.user?.username || 'Unknown';
    const duration = req.body.duration || null;
    
    if (!req.body.audio) {
      return res.status(400).json({ success: false, error: 'Audio data is required' });
    }
    
    const audioBuffer = Buffer.from(req.body.audio, 'base64');
    
    const message = await sendAudioMessage(channel, sender, audioBuffer, duration);
    res.json({ success: true, message });
  } catch (error) {
    console.error('Error sending audio message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
