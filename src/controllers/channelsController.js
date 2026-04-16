import * as channelsService from '../services/channelsService.js';
import { success, error } from '../utils/response.js';
import { getChannelAnnouncementAudio, getZoneAnnouncementAudio } from '../db/index.js';

export async function getAccessibleChannels(req, res) {
  try {
    const userId = req.user?.id ?? req.session?.user?.id;
    const userRole = req.user?.role ?? req.session?.user?.role ?? 'user';
    const username = req.user?.username ?? req.session?.user?.username ?? (req.radio ? `radio:${req.radio.radio_id}` : 'unknown');
    console.log(`[API /channels] Request from user="${username}" id=${userId} role=${userRole} sessionID=${req.sessionID?.substring(0, 8)}...`);
    
    const channels = await channelsService.getAccessibleChannels(userId, userRole);
    
    console.log(`[API /channels] Returning ${channels.length} channels to "${username}" — names: [${channels.map(c => c.room_key || c.name).join(', ')}]`);
    
    success(res, { channels });
  } catch (err) {
    console.error('[API /channels] Get channels error:', err);
    if (err.message?.includes('Cannot read properties of undefined')) {
      console.error('[API /channels] Session user is undefined — session may be invalid or expired');
    }
    error(res, 'Failed to get channels', 500);
  }
}

export async function getChannelAnnouncement(req, res) {
  try {
    const { id } = req.params;
    const audio = await getChannelAnnouncementAudio(parseInt(id, 10));
    if (!audio) {
      return res.status(404).json({ error: 'No announcement audio found for this channel' });
    }
    res.set('Content-Type', 'audio/L16;rate=16000;channels=1');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(audio);
  } catch (err) {
    console.error('[API /channels/:id/announcement] Error:', err);
    error(res, 'Failed to get channel announcement', 500);
  }
}

export async function getZoneAnnouncement(req, res) {
  try {
    const { id } = req.params;
    const audio = await getZoneAnnouncementAudio(parseInt(id, 10));
    if (!audio) {
      return res.status(404).json({ error: 'No announcement audio found for this zone' });
    }
    res.set('Content-Type', 'audio/L16;rate=16000;channels=1');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(audio);
  } catch (err) {
    console.error('[API /zones/:id/announcement] Error:', err);
    error(res, 'Failed to get zone announcement', 500);
  }
}
