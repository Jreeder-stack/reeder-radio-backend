import { getAiSetting, setAiSetting, isAiDispatchEnabled, getAiDispatchChannel } from '../db/index.js';
import { getDispatcher } from './aiDispatchService.js';
import { textToSpeech, isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { floorControlService } from './floorControlService.js';

const SETTING_KEY = 'hourly_time_broadcast_enabled';
const HOUR_WORDS = [
  'zero hundred hours',
  'oh one hundred hours',
  'oh two hundred hours',
  'oh three hundred hours',
  'oh four hundred hours',
  'oh five hundred hours',
  'oh six hundred hours',
  'oh seven hundred hours',
  'oh eight hundred hours',
  'oh nine hundred hours',
  'ten hundred hours',
  'eleven hundred hours',
  'twelve hundred hours',
  'thirteen hundred hours',
  'fourteen hundred hours',
  'fifteen hundred hours',
  'sixteen hundred hours',
  'seventeen hundred hours',
  'eighteen hundred hours',
  'nineteen hundred hours',
  'twenty hundred hours',
  'twenty one hundred hours',
  'twenty two hundred hours',
  'twenty three hundred hours',
];

export function hourToSpokenPhrase(hour) {
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw new RangeError(`hour must be 0-23, got ${hour}`);
  }
  return HOUR_WORDS[h];
}

export async function isHourlyTimeBroadcastEnabled() {
  const value = await getAiSetting(SETTING_KEY);
  if (value === undefined || value === null) return true;
  return value === 'true';
}

export async function setHourlyTimeBroadcastEnabled(enabled) {
  return setAiSetting(SETTING_KEY, enabled ? 'true' : 'false');
}

function localPartsForBroadcast(now = new Date()) {
  const tz = process.env.TZ || undefined;
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: tz,
  });
  const hourFmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: tz,
  });
  let hour = parseInt(hourFmt.format(now), 10);
  if (hour === 24) hour = 0;
  return { hour, dateText: dateFmt.format(now) };
}

export function buildBroadcastMessage(now = new Date()) {
  const { hour, dateText } = localPartsForBroadcast(now);
  return `Statewide Constable Communications System. Today is ${dateText}. The time is ${hourToSpokenPhrase(hour)}.`;
}

function nextHourBoundaryDelayMs(now = Date.now()) {
  const ms = now % 3600000;
  let delay = 3600000 - ms;
  if (delay < 50) delay += 3600000;
  return delay;
}

class HourlyTimeBroadcastScheduler {
  constructor() {
    this._timer = null;
    this._running = false;
    this._nextFireAt = null;
  }

  log(action, details = {}) {
    const ts = new Date().toISOString();
    console.log(`[HourlyTimeBroadcast] ${ts} | ${action}`, JSON.stringify(details));
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._scheduleNext();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._nextFireAt = null;
  }

  getNextFireAt() {
    return this._nextFireAt;
  }

  _scheduleNext() {
    if (!this._running) return;
    const delay = nextHourBoundaryDelayMs();
    this._nextFireAt = new Date(Date.now() + delay);
    this._timer = setTimeout(() => this._fire().catch(err => {
      this.log('FIRE_ERROR', { error: err.message });
    }).finally(() => this._scheduleNext()), delay);
    if (this._timer.unref) this._timer.unref();
    this.log('SCHEDULED', { nextFireAt: this._nextFireAt.toISOString(), delayMs: delay });
  }

  async _fire() {
    let enabled;
    try {
      enabled = await isHourlyTimeBroadcastEnabled();
    } catch (err) {
      this.log('SETTING_READ_ERROR', { error: err.message });
      return;
    }
    if (!enabled) {
      this.log('SKIPPED', { reason: 'disabled_by_setting' });
      return;
    }

    if (!isAzureConfigured()) {
      this.log('SKIPPED', { reason: 'azure_not_configured' });
      return;
    }

    let aiEnabled = false;
    let dispatchChannel = null;
    try {
      aiEnabled = await isAiDispatchEnabled();
      dispatchChannel = await getAiDispatchChannel();
    } catch (err) {
      this.log('AI_STATE_READ_ERROR', { error: err.message });
      return;
    }
    if (!aiEnabled || !dispatchChannel) {
      this.log('SKIPPED', { reason: 'ai_dispatch_not_configured', aiEnabled, dispatchChannel });
      return;
    }

    const dispatcher = getDispatcher();
    if (!dispatcher.isRunning || !dispatcher.connected || !dispatcher.channelName) {
      this.log('SKIPPED', { reason: 'dispatcher_not_connected', channel: dispatchChannel });
      return;
    }

    const channelKey = dispatcher.channelName;
    const holder = floorControlService.getFloorHolder(channelKey);
    if (holder && holder.unitId !== 'AI-Dispatcher') {
      this.log('SKIPPED', { reason: 'channel_busy', channel: channelKey, heldBy: holder.unitId });
      return;
    }

    const message = buildBroadcastMessage(new Date());
    this.log('BROADCAST_START', { channel: channelKey, message });

    try {
      const audio = await textToSpeech(message);
      await dispatcher.publishAudio(audio, message);
      this.log('BROADCAST_COMPLETE', { channel: channelKey });
    } catch (err) {
      this.log('BROADCAST_ERROR', { error: err.message });
    }
  }
}

export const hourlyTimeBroadcastScheduler = new HourlyTimeBroadcastScheduler();
