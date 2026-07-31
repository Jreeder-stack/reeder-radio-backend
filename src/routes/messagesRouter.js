import { Router } from 'express';
import { sendTextMessage, sendAudioMessage, getMessages, transcribeMessage, getAudioFilePath } from '../services/messagesService.js';
import { isValidWav, InvalidAudioBufferError, prepareWavForPlayback } from '../services/wavValidator.js';
import { getMessagesByDateRange, getAudioDataByFilename, getAudioMessageDiagnostics } from '../db/index.js';
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
        const prepared = prepareAudioBuffer(audioData, filename);
        if (prepared.buffer) {
          archive.append(prepared.buffer, { name: filename });
          manifest.push({
            file: filename,
            sender: msg.sender,
            timestamp: msg.created_at,
            duration_ms: msg.audio_duration,
            transcription: msg.transcription || null
          });
        }
      } else {
        const filepath = path.join(AUDIO_DIR, filename);
        if (fs.existsSync(filepath)) {
          const prepared = prepareAudioBuffer(fs.readFileSync(filepath), filename);
          if (prepared.buffer) {
            archive.append(prepared.buffer, { name: filename });
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

function prepareAudioBuffer(buf, filename) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    console.warn('[AudioRoute] Empty or missing audio data — returning 404');
    return { status: 404, buffer: null };
  }

  const prepared = prepareWavForPlayback(buf);
  if (!prepared) {
    console.warn(`[AudioRoute] Invalid or unsupported WAV data for "${filename}" (${buf.length} bytes) — returning 415`);
    return { status: 415, buffer: null };
  }

  if (prepared.repairedLegacyHeader) {
    console.warn(`[AudioRoute] Repaired legacy RecordingTap WAV header for "${filename}"`);
  }

  return { status: 200, buffer: prepared.buffer };
}

function serveAudioBuffer(res, buf, filename) {
  const prepared = prepareAudioBuffer(buf, filename);
  res.setHeader('Content-Type', 'audio/wav');
  if (!prepared.buffer) return res.status(prepared.status).end();
  res.setHeader('Content-Length', prepared.buffer.length);
  return res.send(prepared.buffer);
}

router.head('/audio/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).end();
    }

    const audioData = await getAudioDataByFilename(filename);
    if (audioData && audioData.length > 0) {
      const prepared = prepareAudioBuffer(audioData, filename);
      res.setHeader('Content-Type', 'audio/wav');
      if (!prepared.buffer) return res.status(prepared.status).end();
      res.setHeader('Content-Length', prepared.buffer.length);
      return res.status(prepared.status).end();
    }

    let decodedFilename;
    try { decodedFilename = decodeURIComponent(filename); } catch { decodedFilename = filename; }
    const isSafeDecoded = decodedFilename !== filename && !decodedFilename.includes('..') && !decodedFilename.includes('/') && !decodedFilename.includes('\\');

    if (isSafeDecoded) {
      const decoded = await getAudioDataByFilename(decodedFilename);
      if (decoded && decoded.length > 0) {
        const prepared = prepareAudioBuffer(decoded, decodedFilename);
        res.setHeader('Content-Type', 'audio/wav');
        if (!prepared.buffer) return res.status(prepared.status).end();
        res.setHeader('Content-Length', prepared.buffer.length);
        return res.status(prepared.status).end();
      }
    }

    const filepath = getAudioFilePath(filename) || (isSafeDecoded ? getAudioFilePath(decodedFilename) : null);
    if (filepath) {
      const fileData = fs.readFileSync(filepath);
      const prepared = prepareAudioBuffer(fileData, path.basename(filepath));
      res.setHeader('Content-Type', 'audio/wav');
      if (!prepared.buffer) return res.status(prepared.status).end();
      res.setHeader('Content-Length', prepared.buffer.length);
      return res.status(prepared.status).end();
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
      return serveAudioBuffer(res, audioData, filename);
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
        return serveAudioBuffer(res, decodedAudioData, decodedFilename);
      }
    }

    const filepath = getAudioFilePath(filename);
    if (filepath) {
      return serveAudioBuffer(res, fs.readFileSync(filepath), filename);
    }

    if (isSafeDecoded) {
      const decodedFilepath = getAudioFilePath(decodedFilename);
      if (decodedFilepath) {
        return serveAudioBuffer(res, fs.readFileSync(decodedFilepath), decodedFilename);
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
      console.warn(`[AudioRoute] POST audio rejected: buffer is not a valid WAV (size=${audioBuffer.length}, channel=${channel}, sender=${sender})`);
      return res.status(415).json({ success: false, error: 'Audio must be a valid WAV (RIFF/WAVE) buffer' });
    }

    const message = await sendAudioMessage(channel, sender, audioBuffer, duration);
    res.json({ success: true, message });
  } catch (error) {
    if (error instanceof InvalidAudioBufferError) {
      return res.status(415).json({ success: false, error: error.message });
    }
    console.error('Error sending audio message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
