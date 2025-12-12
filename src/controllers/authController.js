import * as authService from '../services/authService.js';
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

export function me(req, res) {
  if (req.session?.user) {
    success(res, { user: req.session.user });
  } else {
    error(res, 'Not authenticated', 401);
  }
}
