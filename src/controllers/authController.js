import * as authService from '../services/authService.js';
import * as db from '../db/index.js';
import { success, error } from '../utils/response.js';

export async function login(req, res) {
  try {
    const { username, password } = req.body;
    
    console.log(`[AUTH] Login attempt: username="${username}"`);
    
    if (!username || !password) {
      console.log(`[AUTH] Login rejected: missing credentials`);
      return error(res, 'Username and password required', 400);
    }
    
    const result = await authService.validateLogin(username, password);
    
    if (!result.success) {
      console.log(`[AUTH] Login failed for "${username}": ${result.error}`);
      return error(res, result.error, 401);
    }
    
    req.session.user = result.user;
    
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error(`[AUTH] Session save error for "${username}":`, saveErr);
      }
      console.log(`[AUTH] Login success: username="${username}" id=${result.user.id} role=${result.user.role} unit_id=${result.user.unit_id} is_dispatcher=${result.user.is_dispatcher} sessionID=${req.sessionID?.substring(0, 8)}...`);
      
      authService.logUserActivity(result.user.id, result.user.username, 'login', {});
      success(res, { user: result.user });
    });
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    error(res, 'Login failed', 500);
  }
}

export function logout(req, res) {
  const username = req.session?.user?.username || 'unknown';
  const sessionId = req.sessionID?.substring(0, 8) || 'unknown';
  console.log(`[AUTH] Logout: username="${username}" sessionID=${sessionId}...`);
  
  req.session.destroy((err) => {
    if (err) {
      console.error(`[AUTH] Logout session destroy error for "${username}":`, err);
      return error(res, 'Logout failed', 500);
    }
    console.log(`[AUTH] Session destroyed for "${username}"`);
    res.clearCookie('connect.sid');
    success(res, { message: 'Logged out' });
  });
}

export async function me(req, res) {
  const sessionId = req.sessionID?.substring(0, 8) || 'none';
  const hasSession = !!req.session?.user;
  
  console.log(`[AUTH] /me check: hasSession=${hasSession} sessionID=${sessionId}... cookie=${!!req.headers.cookie}`);
  
  if (req.session?.user) {
    try {
      console.log(`[AUTH] /me: session has user="${req.session.user.username}" id=${req.session.user.id}, refreshing from DB...`);
      const freshUser = await db.getUser(req.session.user.username);
      if (freshUser) {
        const userData = {
          id: freshUser.id,
          username: freshUser.username,
          email: freshUser.email,
          role: freshUser.role,
          unit_id: freshUser.unit_id,
          is_dispatcher: freshUser.is_dispatcher
        };
        req.session.user = userData;
        console.log(`[AUTH] /me: returning fresh user data for "${userData.username}" role=${userData.role} unit_id=${userData.unit_id}`);
        success(res, { user: userData });
      } else {
        console.log(`[AUTH] /me: user "${req.session.user.username}" NOT FOUND in DB`);
        error(res, 'User not found', 401);
      }
    } catch (err) {
      console.error(`[AUTH] /me: DB error fetching user, falling back to session data:`, err.message);
      success(res, { user: req.session.user });
    }
  } else {
    console.log(`[AUTH] /me: no session user, returning 401`);
    error(res, 'Not authenticated', 401);
  }
}
