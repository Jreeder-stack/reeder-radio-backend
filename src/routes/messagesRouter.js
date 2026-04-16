import { Router } from 'express';
import { sendTextMessage, sendAudioMessage, getMessages, transcribeMessage, getAudioFilePath } from '../services/messagesService.js';
import { getMessagesByDateRange, getAudioDataByFilename, getAudioMessageDiagnostics } from '../db/index.js';
import { requireDispatcher } from '../middleware/auth.js';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';

const router = Router();

function isValidWav(buf) {
  return Buffer.isBuffer(buf) && buf.length > 12
    && buf.slice(0, 4).toString('ascii') === 'RIFF'
    && buf.slice(8, 12).toString('ascii') === 'WAVE';
}

function wrapPcmInWav(pcmData, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 30);
  buffer.writeUInt16LE(bitsPerSample, 32);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, 44);
  return buffer;
}

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

function looksLikeRawOpusOrOgg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  if (buf.slice(0, 4).toString('ascii') === 'OggS') return true;
  if (buf.length >= 8 && buf.slice(0, 8).toString('ascii') === 'OpusHead') return true;
  return false;
}

function generateSilenceWav(durationMs = 100, sampleRate = 16000) {
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const pcmData = Buffer.alloc(numSamples * 2);
  return wrapPcmInWav(pcmData, sampleRate);
}

function serveAudioBuffer(res, buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    console.warn('[AudioRoute] Empty or missing audio data — returning 404');
    return res.status(404).json({ success: false, error: 'Audio not available' });
  }

  if (looksLikeRawOpusOrOgg(buf)) {
    console.warn(`[AudioRoute] Audio data appears to be raw Opus/Ogg (${buf.length} bytes) — not playable as WAV, serving silence`);
    const silenceWav = generateSilenceWav();
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', silenceWav.length);
    return res.send(silenceWav);
  }

  let audioData = buf;
  if (!isValidWav(audioData)) {
    console.warn('[AudioRoute] Audio data missing WAV headers — wrapping as PCM 16kHz mono 16-bit');
    audioData = wrapPcmInWav(audioData);
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', audioData.length);
  return res.send(audioData);
}

router.head('/audio/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).end();
    }

    const audioData = await getAudioDataByFilename(filename);
    if (audioData && audioData.length > 0) {
      let size = audioData.length;
      if (!isValidWav(audioData)) {
        size = audioData.length + 44;
      }
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', size);
      return res.status(200).end();
    }

    let decodedFilename;
    try { decodedFilename = decodeURIComponent(filename); } catch { decodedFilename = filename; }
    const isSafeDecoded = decodedFilename !== filename && !decodedFilename.includes('..') && !decodedFilename.includes('/') && !decodedFilename.includes('\\');

    if (isSafeDecoded) {
      const decoded = await getAudioDataByFilename(decodedFilename);
      if (decoded && decoded.length > 0) {
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', decoded.length);
        return res.status(200).end();
      }
    }

    const filepath = getAudioFilePath(filename) || (isSafeDecoded ? getAudioFilePath(decodedFilename) : null);
    if (filepath) {
      const stat = fs.statSync(filepath);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', stat.size);
      return res.status(200).end();
    }

    return res.status(404).end();
  } catch (error) {
    console.error('Error handling HEAD for audio:', error);
    res.status(500).end();
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
      return serveAudioBuffer(res, audioData);
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
        return serveAudioBuffer(res, decodedAudioData);
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

    try {
      const diag = await getAudioMessageDiagnostics(filename);
      console.warn(
        `[AudioRoute] Audio file not found: filename="${filename}"${isSafeDecoded ? `, decoded="${decodedFilename}"` : ''} — no match in DB or filesystem`,
        JSON.stringify({
          attemptedUrl: diag.attemptedUrl,
          urlMatchFound: diag.urlMatchFound,
          urlMatchHasData: diag.urlMatchRow?.has_data ?? null,
          urlMatchChannel: diag.urlMatchRow?.channel ?? null,
          urlMatchSender: diag.urlMatchRow?.sender ?? null,
          totalAudioMessages: diag.totalAudioMessages
        })
      );
    } catch (diagErr) {
      console.warn(`[AudioRoute] Audio file not found: filename="${filename}"${isSafeDecoded ? `, decoded="${decodedFilename}"` : ''} — no match in DB or filesystem (diagnostics failed: ${diagErr.message})`);
    }
    res.setHeader('Content-Type', 'audio/wav');
    return res.status(404).end();
  } catch (error) {
    console.error('Error serving audio:', error);
    res.setHeader('Content-Type', 'audio/wav');
    res.status(500).end();
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
    
    let audioBuffer = Buffer.from(req.body.audio, 'base64');
    
    if (!isValidWav(audioBuffer)) {
      console.warn('[AudioRoute] POST audio: buffer missing WAV headers — wrapping as PCM 16kHz mono 16-bit');
      audioBuffer = wrapPcmInWav(audioBuffer);
    }
    
    const message = await sendAudioMessage(channel, sender, audioBuffer, duration);
    res.json({ success: true, message });
  } catch (error) {
    console.error('Error sending audio message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
