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

router.get('/status-check', async (req, res) => {
  try {
    const result = await cadService.getStatusCheck();
    
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Status check error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/unit/:unitId/status/cycle', async (req, res) => {
  try {
    const { unitId } = req.params;
    const result = await cadService.cycleUnitStatus(unitId);
    
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error || 'Cycle status failed' });
    }
    
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Cycle status error:', error);
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

router.get('/animal/types', async (req, res) => {
  try {
    const result = await cadService.getAnimalTypes();
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Animal types error:', error);
    res.json({ types: ['Dog', 'Cat', 'Horse', 'Bird', 'Livestock', 'Wildlife', 'Other'] });
  }
});

router.post('/animal/search', async (req, res) => {
  try {
    const result = await cadService.searchAnimal(req.body);
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Animal search error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/citation/new', async (req, res) => {
  try {
    const { type, populateFrom } = req.body;
    const result = await cadService.createCitation(type, populateFrom, req.user);
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Citation create error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/map/redirect', async (req, res) => {
  try {
    const mapUrl = await cadService.getMapUrl();
    if (mapUrl) {
      res.redirect(mapUrl);
    } else {
      res.status(404).json({ success: false, message: 'Map URL not configured' });
    }
  } catch (error) {
    console.error('[CAD Router] Map redirect error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/unit/current-call', async (req, res) => {
  try {
    const result = await cadService.getUnitCurrentCall(req.user);
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Get current call error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/fi/create', async (req, res) => {
  try {
    const result = await cadService.createFieldInterview(req.body, req.user);
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] FI create error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/fleet/units', async (req, res) => {
  try {
    const result = await cadService.getFleetUnits(req.user);
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Fleet units error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/fleet/unit/:unitId/status', async (req, res) => {
  try {
    const { unitId } = req.params;
    const { status } = req.body;
    const result = await cadService.updateFleetUnitStatus(unitId, status);
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Fleet status error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/fleet/unit/:unitId/fuel', async (req, res) => {
  try {
    const { unitId } = req.params;
    const result = await cadService.addFuelEntry(unitId, req.body);
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Fuel entry error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/bolo/recent', async (req, res) => {
  try {
    const result = await cadService.getRecentBolos();
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] BOLO error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/messages', async (req, res) => {
  try {
    const result = await cadService.getMessages(req.user);
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Messages error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/messages/unread', async (req, res) => {
  try {
    const result = await cadService.getUnreadCount(req.user);
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Unread count error:', error);
    res.json({ count: 0 });
  }
});

router.get('/messages/conversation/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const result = await cadService.getConversation(conversationId, req.user);
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Conversation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/messages/reply', async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    const result = await cadService.sendMessage(conversationId, message, req.user);
    if (result.success === false) {
      return res.status(500).json({ success: false, message: result.error });
    }
    res.json(result);
  } catch (error) {
    console.error('[CAD Router] Send message error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
