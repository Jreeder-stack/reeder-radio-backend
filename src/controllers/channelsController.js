import * as channelsService from '../services/channelsService.js';
import { success, error } from '../utils/response.js';

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
