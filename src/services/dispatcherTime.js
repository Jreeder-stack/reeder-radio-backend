import { DISPATCHER_TZ } from '../utils/timezone.js';

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];

function spokenNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 59) {
    throw new RangeError(`value must be an integer from 0 through 59, got ${value}`);
  }
  if (number < 20) return ONES[number];
  const tens = Math.floor(number / 10);
  const ones = number % 10;
  return ones === 0 ? TENS[tens] : `${TENS[tens]} ${ONES[ones]}`;
}

function getDispatcherHourMinute(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: DISPATCHER_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'hour') hour = Number.parseInt(part.value, 10);
    if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
  }
  if (hour === 24) hour = 0;
  return { hour, minute };
}

export function formatDispatcherTime(date = new Date()) {
  const { hour, minute } = getDispatcherHourMinute(date);
  const hourText = hour < 10 ? `oh ${ONES[hour]}` : spokenNumber(hour);
  const minuteText = minute === 0
    ? 'hundred'
    : minute < 10
      ? `oh ${ONES[minute]}`
      : spokenNumber(minute);

  return `${hourText} ${minuteText} hours`;
}
