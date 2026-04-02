import express from 'express';
import * as authController from '../controllers/authController.js';
import { requireCadApiKey } from '../middleware/cadApiKey.js';
import { cadLogin } from '../controllers/cadIntegrationController.js';

const router = express.Router();

router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/me', authController.me);
router.post('/cad-login', requireCadApiKey, cadLogin);

export default router;
