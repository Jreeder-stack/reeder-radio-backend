import express from "express";
import {
  upsertUnitPresence,
  getAllUnitPresence,
  logRadioEvent,
  getMonitorSet,
  setMonitorSet,
  setUnitEmergency,
  getAllRadioChannels,
  createRadioChannel,
  updateRadioChannel,
  getAllChannelPatches,
  createChannelPatch,
  updateChannelPatch
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

router.post("/units/:id/emergency", async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;
    const unit = await setUnitEmergency(id, active);
    if (!unit) {
      return res.status(404).json({ error: "Unit not found" });
    }
    await logRadioEvent(unit.unit_identity, unit.channel, active ? "emergency_activated" : "emergency_cleared", { active });
    res.json({ unit });
  } catch (error) {
    console.error("Emergency toggle error:", error);
    res.status(500).json({ error: "Failed to toggle emergency status" });
  }
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
  const { primary, monitored, primaryTxChannelId } = req.body;
  const result = await setMonitorSet(req.params.dispatcherId, primary, monitored, primaryTxChannelId);
  res.json({ monitor: result });
});

router.get("/channels", async (req, res) => {
  try {
    const channels = await getAllRadioChannels();
    res.json({ channels });
  } catch (error) {
    console.error("Get radio channels error:", error);
    res.status(500).json({ error: "Failed to get radio channels" });
  }
});

router.post("/channels", async (req, res) => {
  try {
    const { name, livekit_room_name, is_emergency_only, is_active } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Channel name required" });
    }
    const channel = await createRadioChannel(name, livekit_room_name || name, is_emergency_only, is_active);
    res.json({ channel });
  } catch (error) {
    console.error("Create radio channel error:", error);
    res.status(500).json({ error: "Failed to create radio channel" });
  }
});

router.patch("/channels/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const channel = await updateRadioChannel(id, req.body);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }
    res.json({ channel });
  } catch (error) {
    console.error("Update radio channel error:", error);
    res.status(500).json({ error: "Failed to update radio channel" });
  }
});

router.get("/patches", async (req, res) => {
  try {
    const patches = await getAllChannelPatches();
    res.json({ patches });
  } catch (error) {
    console.error("Get channel patches error:", error);
    res.status(500).json({ error: "Failed to get channel patches" });
  }
});

router.post("/patches", async (req, res) => {
  try {
    const { name, source_channel_id, target_channel_id, is_enabled } = req.body;
    if (!source_channel_id || !target_channel_id) {
      return res.status(400).json({ error: "Source and target channel IDs required" });
    }
    const patch = await createChannelPatch(name, source_channel_id, target_channel_id, is_enabled);
    res.json({ patch });
  } catch (error) {
    console.error("Create channel patch error:", error);
    res.status(500).json({ error: "Failed to create channel patch" });
  }
});

router.patch("/patches/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const patch = await updateChannelPatch(id, req.body);
    if (!patch) {
      return res.status(404).json({ error: "Patch not found" });
    }
    res.json({ patch });
  } catch (error) {
    console.error("Update channel patch error:", error);
    res.status(500).json({ error: "Failed to update channel patch" });
  }
});

export default router;
