import { getAiSetting, setAiSetting, isAiDispatchEnabled, getAiDispatchChannel } from '../db/index.js';
import { getDispatcher } from './aiDispatchService.js';
import { textToSpeech, isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { floorControlService } from './floorControlService.js';

const SETTING_KEY = 'hourly_time_broadcast_enabled';
const BROADCAST_TZ = 'America/New_York';
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

const SPOKEN_NUM_ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const SPOKEN_NUM_DECADES = ['','','twenty','thirty','forty','fifty'];

function spokenNum(n) {
  if (n < 20) return SPOKEN_NUM_ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? SPOKEN_NUM_DECADES[t] : `${SPOKEN_NUM_DECADES[t]} ${SPOKEN_NUM_ONES[o]}`;
}

function getEasternHourMinute(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: BROADCAST_TZ,
  });
  const parts = fmt.formatToParts(now);
  let hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  if (hour === 24) hour = 0;
  return { hour, minute };
}

export function formatSpokenTime24(date = new Date()) {
  const { hour, minute } = getEasternHourMinute(date);
  const hourWord = hour < 10 ? `oh ${SPOKEN_NUM_ONES[hour]}` : spokenNum(hour);
  let minuteWord;
  if (minute === 0) {
    minuteWord = 'hundred';
  } else if (minute < 10) {
    minuteWord = `oh ${SPOKEN_NUM_ONES[minute]}`;
  } else {
    minuteWord = spokenNum(minute);
  }
  return `${hourWord} ${minuteWord} hours`;
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
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: BROADCAST_TZ,
  });
  return { dateText: dateFmt.format(now) };
}

export function buildBroadcastMessage(now = new Date()) {
  const { dateText } = localPartsForBroadcast(now);
  const timeText = formatSpokenTime24(now);
  return `Statewide Constable Communications System. Today is ${dateText}. The time is ${timeText}.`;
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
    const result = await this._broadcastNow({ source: 'scheduled' });
    if (!result.played) {
      this.log('SKIPPED', { reason: result.status, ...result.details });
    }
  }

  async _broadcastNow({ source }) {
    if (!isAzureConfigured()) {
      return { played: false, status: 'azure_not_configured', details: {} };
    }

    let aiEnabled = false;
    let dispatchChannel = null;
    try {
      aiEnabled = await isAiDispatchEnabled();
      dispatchChannel = await getAiDispatchChannel();
    } catch (err) {
      this.log('AI_STATE_READ_ERROR', { error: err.message, source });
      return { played: false, status: 'ai_not_configured', details: { error: err.message } };
    }
    if (!aiEnabled || !dispatchChannel) {
      return { played: false, status: 'ai_not_configured', details: { aiEnabled, dispatchChannel } };
    }

    const dispatcher = getDispatcher();
    if (!dispatcher.isRunning || !dispatcher.connected || !dispatcher.channelName) {
      return { played: false, status: 'dispatcher_not_connected', details: { channel: dispatchChannel } };
    }

    const channelKey = dispatcher.channelName;
    const holder = floorControlService.getFloorHolder(channelKey);
    if (holder && holder.unitId !== 'AI-Dispatcher') {
      return { played: false, status: 'channel_busy', details: { channel: channelKey, heldBy: holder.unitId } };
    }

    const message = buildBroadcastMessage(new Date());
    this.log('BROADCAST_START', { channel: channelKey, message, source });

    try {
      const audio = await textToSpeech(message);
      await dispatcher.publishAudio(audio, message);
      this.log('BROADCAST_COMPLETE', { channel: channelKey, source });
      return { played: true, status: 'played', details: { channel: channelKey, message } };
    } catch (err) {
      this.log('BROADCAST_ERROR', { error: err.message, source });
      return { played: false, status: 'broadcast_error', details: { error: err.message } };
    }
  }

  async playNow() {
    return this._broadcastNow({ source: 'manual' });
  }
}

export const hourlyTimeBroadcastScheduler = new HourlyTimeBroadcastScheduler();
