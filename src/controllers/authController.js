import * as authService from '../services/authService.js';
import * as db from '../db/index.js';
import { success, error } from '../utils/response.js';

export async function login(req, res) {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return error(res, 'Username and password required', 400);
    }
    
    const result = await authService.validateLogin(username, password);
    
    if (!result.success) {
      return error(res, result.error, 401);
    }
    
    req.session.user = result.user;
    await authService.logUserActivity(result.user.id, result.user.username, 'login', {});
    
    success(res, { user: result.user });
  } catch (err) {
    console.error('Login error:', err);
    error(res, 'Login failed', 500);
  }
}

export function logout(req, res) {
  req.session.destroy((err) => {
    if (err) {
      return error(res, 'Logout failed', 500);
    }
    res.clearCookie('connect.sid');
    success(res, { message: 'Logged out' });
  });
}

export async function me(req, res) {
  if (req.session?.user) {
    try {
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
        success(res, { user: userData });
      } else {
        error(res, 'User not found', 401);
      }
    } catch (err) {
      console.error('Error fetching user:', err);
      success(res, { user: req.session.user });
    }
  } else {
    error(res, 'Not authenticated', 401);
  }
}
