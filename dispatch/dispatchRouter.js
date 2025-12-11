import express from "express";
import {
  upsertUnitPresence,
  getAllUnitPresence,
  logRadioEvent,
  getMonitorSet,
  setMonitorSet
} from "../db.js";

const router = express.Router();

router.get("/units", async (req, res) => {
  const units = await getAllUnitPresence();
  res.json({ units });
});

router.post("/unit/update", async (req, res) => {
  const { identity, channel, status, location, isEmergency } = req.body;
  const unit = await upsertUnitPresence(identity, channel, status, location, isEmergency);
  await logRadioEvent(identity, channel, "status_update", { status });
  res.json({ unit });
});

router.post("/emergency/ack", async (req, res) => {
  const { identity, channel, acknowledgedBy } = req.body;
  await logRadioEvent(identity, channel, "emergency_ack", { acknowledgedBy });
  res.json({ success: true });
});

router.get("/monitor/:dispatcherId", async (req, res) => {
  const data = await getMonitorSet(req.params.dispatcherId);
  res.json({ monitor: data });
});

router.post("/monitor/:dispatcherId", async (req, res) => {
  const { primary, monitored } = req.body;
  const result = await setMonitorSet(req.params.dispatcherId, primary, monitored);
  res.json({ monitor: result });
});

export default router;
