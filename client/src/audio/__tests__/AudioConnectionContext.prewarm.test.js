import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(
  __dirname,
  '../../context/AudioConnectionContext.jsx'
);
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

function extractInitBody(src) {
  const marker = 'const init = async () => {';
  const start = src.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth === 0 ? src.slice(start + marker.length, i - 1) : null;
}

describe('AudioConnectionContext — playback pre-warm before first RX packet (Task #380 regression)', () => {
  it('contains an init() async arrow function in the connect-on-mount useEffect', () => {
    const body = extractInitBody(SRC);
    expect(body, 'init = async () => { ... } block not found').toBeTruthy();
  });

  it('awaits audioTransportManager.prepareConnection() inside init() (not fire-and-forget)', () => {
    const body = extractInitBody(SRC);
    expect(body).toBeTruthy();
    expect(body).toMatch(/await\s+audioTransportManager\.prepareConnection\s*\(/);
  });

  it('does NOT call audioTransportManager.prepareConnection() without await inside init()', () => {
    const body = extractInitBody(SRC);
    expect(body).toBeTruthy();
    const allCalls = [...body.matchAll(/audioTransportManager\.prepareConnection\s*\(/g)];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const m of allCalls) {
      const before = body.slice(Math.max(0, m.index - 32), m.index);
      expect(
        /await\s+$/.test(before),
        `prepareConnection() call at offset ${m.index} is not awaited (preceding text: "${before}")`,
      ).toBe(true);
    }
  });

  it('awaits prepareConnection() BEFORE invoking initializeConnections() (which opens the first WebSocket)', () => {
    const body = extractInitBody(SRC);
    expect(body).toBeTruthy();
    const prepIdx = body.search(/await\s+audioTransportManager\.prepareConnection\s*\(/);
    const initConnIdx = body.search(/initializeConnections\s*\(/);
    expect(prepIdx, 'awaited prepareConnection() not found in init()').toBeGreaterThan(-1);
    expect(initConnIdx, 'initializeConnections() call not found in init()').toBeGreaterThan(-1);
    expect(
      prepIdx < initConnIdx,
      `prepareConnection() (offset ${prepIdx}) must precede initializeConnections() (offset ${initConnIdx})`,
    ).toBe(true);
  });

  it('does not call audioTransportManager.connect() in init() before prepareConnection() is awaited', () => {
    const body = extractInitBody(SRC);
    expect(body).toBeTruthy();
    const prepIdx = body.search(/await\s+audioTransportManager\.prepareConnection\s*\(/);
    expect(prepIdx).toBeGreaterThan(-1);
    const beforePrep = body.slice(0, prepIdx);
    expect(
      /audioTransportManager\.connect\s*\(/.test(beforePrep),
      'audioTransportManager.connect() must not be invoked before prepareConnection() is awaited',
    ).toBe(false);
  });
});
