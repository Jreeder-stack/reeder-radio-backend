import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(
  __dirname,
  '../../pages/DispatchConsole.jsx'
);
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

function findMonitorEffect(src) {
  const marker = 'monitoredChannelIds';
  const dep = src.lastIndexOf('[monitoredChannelIds');
  if (dep === -1) return null;
  const effectStart = src.lastIndexOf('useEffect(() => {', dep);
  if (effectStart === -1) return null;
  return src.slice(effectStart, dep);
}

describe('DispatchConsole — monitor effect reconciles against AudioTransportManager (Task #428)', () => {
  it('contains a monitor-driven useEffect with monitoredChannelIds in its deps', () => {
    const body = findMonitorEffect(SRC);
    expect(body, 'monitor useEffect not found').toBeTruthy();
  });

  it('reads the live connected-channel set from audioTransportManager.getConnectedChannels()', () => {
    const body = findMonitorEffect(SRC);
    expect(body).toBeTruthy();
    expect(body).toMatch(/audioTransportManager\.getConnectedChannels\s*\(/);
  });

  it('does NOT use a prevMonitoredRef-style diff (which is desync-prone at startup)', () => {
    const body = findMonitorEffect(SRC);
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/prevMonitoredRef/);
    expect(body).not.toMatch(/prevRoomKeys/);
  });

  it('disconnects channels that are connected but not monitored (and not in an override set)', () => {
    const body = findMonitorEffect(SRC);
    expect(body).toBeTruthy();
    // Must call disconnectFromChannel guarded by a "not monitored" check.
    expect(body).toMatch(/disconnectFromChannel\s*\(/);
    expect(body).toMatch(/monitoredSet|monitoredRoomKeys/);
  });

  it('whitelists clear-air as an override owner so reconcile does not tear it down', () => {
    const body = findMonitorEffect(SRC);
    expect(body).toBeTruthy();
    expect(body).toMatch(/clearAirChannel/);
  });

  it('connects monitored channels that are not yet connected', () => {
    const body = findMonitorEffect(SRC);
    expect(body).toBeTruthy();
    expect(body).toMatch(/connectToChannel\s*\(/);
    expect(body).toMatch(/audioTransportManager\.isConnected\s*\(/);
  });
});
