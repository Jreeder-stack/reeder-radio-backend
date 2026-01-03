import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as cadService from '../services/cadService.js';

const router = Router();

router.use(requireAuth);

router.post('/query/person', async (req, res) => {
  try {
    const { firstName, lastName, dob } = req.body;
    
    if (!firstName && !lastName) {
      return res.status(400).json({ success: false, message: 'First name or last name is required' });
    }
    
    const result = await cadService.queryPerson(firstName || '', lastName || '', dob || null);
    
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error || 'Query failed' });
    }
    
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Person query error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/query/vehicle', async (req, res) => {
  try {
    const { plate, state, vin } = req.body;
    
    if (!plate && !vin) {
      return res.status(400).json({ success: false, message: 'Plate or VIN is required' });
    }
    
    const result = await cadService.queryVehicle(plate || '', state || 'PA');
    
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error || 'Query failed' });
    }
    
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Vehicle query error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/query/warrant', async (req, res) => {
  try {
    const { firstName, lastName } = req.body;
    
    if (!firstName || !lastName) {
      return res.status(400).json({ success: false, message: 'First and last name are required' });
    }
    
    const result = await cadService.queryWarrant(firstName, lastName);
    
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error || 'Query failed' });
    }
    
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Warrant query error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/calls', async (req, res) => {
  try {
    const { status } = req.query;
    const result = await cadService.getActiveCalls(status || null);
    
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Get calls error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/call/:callId', async (req, res) => {
  try {
    const { callId } = req.params;
    const result = await cadService.getCallDetails(callId);
    
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Get call details error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/broadcast', async (req, res) => {
  try {
    const { message, priority } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }
    
    const result = await cadService.sendBroadcast(message, priority || 'routine');
    
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Broadcast error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
