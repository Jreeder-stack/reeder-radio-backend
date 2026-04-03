import express from 'express';
import * as authController from '../controllers/authController.js';
import { requireCadApiKey } from '../middleware/cadApiKey.js';
import { cadLogin } from '../controllers/cadIntegrationController.js';

function buildAuthRouter(rateLimitMiddleware) {
  const router = express.Router();
  const rateLimit = rateLimitMiddleware ? [rateLimitMiddleware] : [];

  router.post('/login', ...rateLimit, authController.login);
  router.post('/register', ...rateLimit, authController.register);
  router.post('/logout', authController.logout);
  router.get('/me', authController.me);
  router.post('/cad-login', requireCadApiKey, cadLogin);

  return router;
}

export function createAuthRouter(rateLimitAuth) {
  return buildAuthRouter(rateLimitAuth);
}

export default buildAuthRouter();
