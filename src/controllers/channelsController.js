import * as channelsService from '../services/channelsService.js';
import { success, error } from '../utils/response.js';

export async function getAccessibleChannels(req, res) {
  try {
    const userId = req.session.user.id;
    const userRole = req.session.user.role;
    const channels = await channelsService.getAccessibleChannels(userId, userRole);
    
    console.log('[API /channels] User:', req.session.user.username, 'Role:', userRole);
    console.log('[API /channels] Returning', channels.length, 'channels');
    
    success(res, { channels });
  } catch (err) {
    console.error('Get channels error:', err);
    error(res, 'Failed to get channels', 500);
  }
}
