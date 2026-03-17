import { useState, useEffect, useRef, useCallback } from 'react';
import { signalingManager } from '../../signaling/SignalingManager';
import { useLiveKitConnection } from '../../context/LiveKitConnectionContext';
import { useSignalingContext } from '../../context/SignalingContext';

export function useClearAir({ identity, channels, isScanning, scanChannels }) {
  const [clearAirActive, setClearAirActive] = useState(false);
  const [clearAirChannelName, setClearAirChannelName] = useState('');

  const { connectToChannel, disconnectFromChannel, ensureConnected, activeChannel } = useLiveKitConnection();
  const { joinChannel: signalingJoinChannel, leaveChannel: signalingLeaveChannel } = useSignalingContext();

  const forcedRoomRef = useRef(null);
  const pendingEventRef = useRef(null);

  const channelsRef = useRef(channels);
  const isScanningRef = useRef(isScanning);
  const scanChannelsRef = useRef(scanChannels);
  const activeChannelRef = useRef(activeChannel);

  useEffect(() => { channelsRef.current = channels; }, [channels]);
  useEffect(() => { isScanningRef.current = isScanning; }, [isScanning]);
  useEffect(() => { scanChannelsRef.current = scanChannels; }, [scanChannels]);
  useEffect(() => { activeChannelRef.current = activeChannel; }, [activeChannel]);

  const isChannelInScanList = useCallback((channelId, chans, scanning, scanList) => {
    if (!scanning) return false;
    return scanList.some(sc => {
      if (!sc.enabled) return false;
      const matchCh = chans.find(ch => String(ch.id) === String(sc.id));
      if (!matchCh) return false;
      const rk = matchCh.room_key || ((matchCh.zone || 'Default') + '__' + matchCh.name);
      return rk === channelId;
    });
  }, []);

  const isChannelNeededNormally = useCallback((channelId) => {
    if (activeChannelRef.current === channelId) return true;
    return isChannelInScanList(channelId, channelsRef.current, isScanningRef.current, scanChannelsRef.current);
  }, [isChannelInScanList]);

  const applyForcedConnect = useCallback((channelId, channelName) => {
    const chans = channelsRef.current;
    const scanning = isScanningRef.current;
    const scanList = scanChannelsRef.current;
    const selected = activeChannelRef.current;

    const inScan = isChannelInScanList(channelId, chans, scanning, scanList);
    const isSelected = selected === channelId;

    if (!inScan && !isSelected) return;

    if (forcedRoomRef.current?.forced === channelId) {
      setClearAirActive(true);
      setClearAirChannelName(channelName || channelId);
      return;
    }

    forcedRoomRef.current = { forced: channelId, wasForced: !isSelected };
    setClearAirActive(true);
    setClearAirChannelName(channelName || channelId);

    if (isSelected) {
      ensureConnected(channelId).catch(err => {
        console.warn('[useClearAir] Failed to ensure connection to selected channel:', err);
      });
    } else {
      connectToChannel(channelId, identity).catch(err => {
        console.warn('[useClearAir] Failed to force-connect to scan channel:', err);
      });
      signalingJoinChannel(channelId);
    }

    console.log('[useClearAir] Clear Air active on', channelId, isSelected ? '(selected)' : '(scan match)');
  }, [isChannelInScanList, ensureConnected, connectToChannel, identity, signalingJoinChannel]);

  const releaseForcedConnection = useCallback((channelId) => {
    if (isChannelNeededNormally(channelId)) {
      console.log('[useClearAir] Keeping channel', channelId, '(still needed normally)');
      return;
    }
    signalingLeaveChannel(channelId);
    disconnectFromChannel(channelId).catch(err => {
      console.warn('[useClearAir] Failed to disconnect forced channel:', err);
    });
    console.log('[useClearAir] Released forced Clear Air channel', channelId);
  }, [isChannelNeededNormally, signalingLeaveChannel, disconnectFromChannel]);

  const handleClearAirStart = useCallback((data) => {
    const { channelId, channelName } = data;

    if (!channelsRef.current.length) {
      pendingEventRef.current = { channelId, channelName };
      console.log('[useClearAir] Queuing Clear Air event (channels not loaded yet)', channelId);
      return;
    }

    applyForcedConnect(channelId, channelName);
  }, [applyForcedConnect]);

  const handleClearAirEnd = useCallback(() => {
    const session = forcedRoomRef.current;
    pendingEventRef.current = null;
    setClearAirActive(false);
    setClearAirChannelName('');
    if (session) {
      forcedRoomRef.current = null;
      if (session.wasForced) {
        releaseForcedConnection(session.forced);
      }
    }
  }, [releaseForcedConnection]);

  useEffect(() => {
    const removeClearAirStart = signalingManager.on('clearAirStart', handleClearAirStart);
    const removeClearAirAlert = signalingManager.on('clear_air:alert', handleClearAirStart);
    const removeClearAirEnd = signalingManager.on('clearAirEnd', handleClearAirEnd);

    return () => {
      removeClearAirStart();
      removeClearAirAlert();
      removeClearAirEnd();
    };
  }, [handleClearAirStart, handleClearAirEnd]);

  useEffect(() => {
    if (!pendingEventRef.current || !channels.length) return;
    const { channelId, channelName } = pendingEventRef.current;
    pendingEventRef.current = null;
    applyForcedConnect(channelId, channelName);
  }, [channels, applyForcedConnect]);

  useEffect(() => {
    if (!clearAirActive || !forcedRoomRef.current) return;
    const { forced, wasForced } = forcedRoomRef.current;

    if (!wasForced) {
      if (activeChannel !== forced) {
        forcedRoomRef.current = null;
        setClearAirActive(false);
        setClearAirChannelName('');
        console.log('[useClearAir] User navigated away from Clear Air channel, clearing banner', forced);
      }
      return;
    }

    const stillInScan = isChannelInScanList(forced, channels, isScanning, scanChannels);
    if (!stillInScan) {
      forcedRoomRef.current = null;
      setClearAirActive(false);
      setClearAirChannelName('');
      releaseForcedConnection(forced);
    }
  }, [clearAirActive, activeChannel, isScanning, scanChannels, channels, isChannelInScanList, releaseForcedConnection]);

  return { clearAirActive, clearAirChannelName };
}
