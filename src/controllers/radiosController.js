import { getAllRadios, getRadioById, assignRadioUnit, setRadioLocked, getAllUsers } from '../db/index.js';
import { success, error } from '../utils/response.js';
import { signalingService } from '../services/signalingService.js';

export async function listRadios(req, res) {
  try {
    const radios = await getAllRadios();
    success(res, { radios });
  } catch (err) {
    console.error('[Radios] listRadios error:', err);
    error(res, 'Failed to list radios', 500);
  }
}

export async function assignUnit(req, res) {
  try {
    const { id } = req.params;
    const { unit_id } = req.body;

    const radio = await getRadioById(id);
    if (!radio) {
      return error(res, 'Radio not found', 404);
    }

    const previousUnitId = radio.assigned_unit_id;
    const updated = await assignRadioUnit(id, unit_id || null);

    if (previousUnitId && previousUnitId !== unit_id) {
      const unassignedSocket = signalingService._findSocketByUnitId(previousUnitId);
      if (unassignedSocket) {
        unassignedSocket.emit('radio:unassigned', {
          radioId: radio.radio_id,
          timestamp: Date.now(),
        });
      }
    }

    if (unit_id) {
      const assignedSocket = signalingService._findSocketByUnitId(unit_id);
      if (assignedSocket) {
        assignedSocket.emit('radio:assigned', {
          radioId: updated.radio_id,
          unitId: unit_id,
          timestamp: Date.now(),
        });
      }
    }

    success(res, { radio: updated });
  } catch (err) {
    console.error('[Radios] assignUnit error:', err);
    error(res, 'Failed to assign unit', 500);
  }
}

export async function lockRadio(req, res) {
  try {
    const { id } = req.params;
    const { locked } = req.body;

    const radio = await getRadioById(id);
    if (!radio) {
      return error(res, 'Radio not found', 404);
    }

    const updated = await setRadioLocked(id, locked);

    if (radio.assigned_unit_id) {
      const unitSocket = signalingService._findSocketByUnitId(radio.assigned_unit_id);
      if (unitSocket) {
        unitSocket.emit(locked ? 'radio:locked' : 'radio:unlocked', {
          radioId: radio.radio_id,
          timestamp: Date.now(),
        });
      }
    }

    success(res, { radio: updated });
  } catch (err) {
    console.error('[Radios] lockRadio error:', err);
    error(res, 'Failed to update radio lock state', 500);
  }
}

export async function listUsers(req, res) {
  try {
    const users = await getAllUsers();
    success(res, { users });
  } catch (err) {
    console.error('[Radios] listUsers error:', err);
    error(res, 'Failed to list users', 500);
  }
}
