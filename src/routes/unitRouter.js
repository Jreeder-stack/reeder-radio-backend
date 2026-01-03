import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as cadService from '../services/cadService.js';
import pool from '../db/index.js';

const router = Router();

router.use(requireAuth);

router.post('/status', async (req, res) => {
  try {
    const { status } = req.body;
    const unitId = req.session?.user?.unit_id || req.session?.user?.username;
    
    if (!unitId) {
      return res.status(400).json({ success: false, message: 'Unit ID not found' });
    }
    
    if (!status) {
      return res.status(400).json({ success: false, message: 'Status is required' });
    }
    
    const result = await cadService.updateUnitStatus(unitId, status);
    
    try {
      await pool.query(
        'UPDATE users SET status = $1 WHERE unit_id = $2 OR username = $2',
        [status, unitId]
      );
    } catch (dbError) {
      console.warn('[Unit Router] Failed to update local status:', dbError.message);
    }
    
    res.json({ success: true, status, cadResult: result });
  } catch (error) {
    console.error('[Unit Router] Status update error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const unitId = req.session?.user?.unit_id || req.session?.user?.username;
    
    if (!unitId) {
      return res.status(400).json({ success: false, message: 'Unit ID not found' });
    }
    
    const result = await pool.query(
      'SELECT status FROM users WHERE unit_id = $1 OR username = $1',
      [unitId]
    );
    
    const status = result.rows[0]?.status || 'off_duty';
    res.json({ success: true, status });
  } catch (error) {
    console.error('[Unit Router] Get status error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/contacts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, unit_id, role, status 
      FROM users 
      WHERE status != 'blocked' AND unit_id IS NOT NULL AND unit_id != ''
      ORDER BY unit_id
    `);
    
    const contacts = result.rows.map(row => ({
      id: row.id,
      name: row.unit_id || row.username,
      role: row.role,
      status: row.status || 'off_duty'
    }));
    
    res.json({ success: true, contacts });
  } catch (error) {
    console.error('[Unit Router] Get contacts error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
