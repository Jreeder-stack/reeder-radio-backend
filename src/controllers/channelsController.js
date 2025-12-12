import * as channelsService from '../services/channelsService.js';
import { success, error } from '../utils/response.js';

export async function getAccessibleChannels(req, res) {
  try {
    const userId = req.session.user.id;
    const channels = await channelsService.getAccessibleChannels(userId);
    
    const grouped = {};
    for (const ch of channels) {
      if (!grouped[ch.zone]) {
        grouped[ch.zone] = [];
      }
      grouped[ch.zone].push(ch);
    }
    
    success(res, { zones: grouped });
  } catch (err) {
    console.error('Get channels error:', err);
    error(res, 'Failed to get channels', 500);
  }
}
