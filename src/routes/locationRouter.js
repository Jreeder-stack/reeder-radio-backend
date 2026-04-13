import express from 'express';
import locationService from '../services/locationService.js';

const router = express.Router();

router.post('/', (req, res) => {
  const { unitId, lat, lng, accuracy, channel } = req.body;
  
  if (!unitId || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Missing required fields: unitId, lat, lng' });
  }
  
  const success = locationService.updateLocation(unitId, parseFloat(lat), parseFloat(lng), accuracy, channel);
  
  if (success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid location data' });
  }
});

router.get('/', (req, res) => {
  const locations = locationService.getAllLocations();
  res.json({ locations });
});

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  
  locationService.addSSEClient(res);
});

router.get('/:unitId/address', async (req, res) => {
  try {
    const result = await locationService.getUnitAddress(req.params.unitId);
    if (result) {
      res.json(result);
    } else {
      res.status(404).json({ error: 'Unit not found or location expired' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to resolve address' });
  }
});

router.get('/:unitId', (req, res) => {
  const location = locationService.getLocation(req.params.unitId);
  if (location) {
    res.json({ location });
  } else {
    res.status(404).json({ error: 'Unit not found or location expired' });
  }
});

export default router;
