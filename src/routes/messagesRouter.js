import { Router } from 'express';
import { sendTextMessage, sendAudioMessage, getMessages, transcribeMessage, getAudioFilePath } from '../services/messagesService.js';

const router = Router();

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

router.get('/audio/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }
    
    const filepath = getAudioFilePath(filename);
    
    if (!filepath) {
      return res.status(404).json({ success: false, error: 'Audio file not found' });
    }
    
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(filepath);
  } catch (error) {
    console.error('Error serving audio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
