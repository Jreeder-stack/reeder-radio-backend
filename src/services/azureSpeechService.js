import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { withV3Stage, V3_DEADLINES } from '../dispatcher-v3/operationDeadline.js';

const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'eastus';

const SILENCE_TIMEOUT_MS = parseInt(process.env.STT_SILENCE_TIMEOUT_MS, 10) || 2500;
const NO_SPEECH_TIMEOUT_MS = parseInt(process.env.STT_NO_SPEECH_TIMEOUT_MS, 10) || 5000;
const SESSION_GUARD_TIMEOUT_MS = parseInt(process.env.STT_SESSION_GUARD_TIMEOUT_MS, 10) || 30000;

const PHRASE_LIST = [
  'Central',
  'Indiana',
  'Snyder',
  'Lancaster',
  'Bedford',
  'Chester',
  'on duty',
  'en route',
  'on scene',
  'on location',
  'available',
  'off duty',
  'out of service',
  'clear',

  'Christopher Columbus Boulevard',
  'Christopher Columbus Blvd',
  'Wheatsheaf Lane',
  'Broad Street',
  'Market Street',
  'Chestnut Street',
  'Walnut Street',
  'Spring Garden Street',
  'Girard Avenue',
  'Oregon Avenue',
  'Passyunk Avenue',
  'Allegheny Avenue',
  'Lehigh Avenue',
  'Frankford Avenue',
  'Kensington Avenue',
  'Front Street',
  'Second Street',
  'Third Street',
  'Fourth Street',
  'Fifth Street',
  'Sixth Street',
  'Seventh Street',
  'Eighth Street',
  'Ninth Street',
  'Tenth Street',
  'Eleventh Street',
  'Twelfth Street',
  'Thirteenth Street',
  'Aramingo Avenue',
  'Torresdale Avenue',
  'Roosevelt Boulevard',
  'Cottman Avenue',
  'Bustleton Avenue',
  'Castor Avenue',
  'Rising Sun Avenue',
  'Germantown Avenue',
  'Ridge Avenue',
  'Henry Avenue',
  'Lincoln Drive',
  'City Avenue',
  'Cobbs Creek Parkway',
  'Woodland Avenue',
  'Baltimore Avenue',
  'Chester Avenue',
  'Island Avenue',
  'Lindbergh Boulevard',
  'Penrose Avenue',
  'Packer Avenue',
  'Delaware Avenue',
  'Columbus Boulevard',
  'Washington Avenue',
  'Snyder Avenue',
  'Tasker Street',
  'Morris Street',
  'Moyamensing Avenue',
  'Wolf Street',
  'Pattison Avenue',
  'Hunting Park Avenue',
  'Erie Avenue',
  'Olney Avenue',
  'Cheltenham Avenue',
  'Ogontz Avenue',
  'Stenton Avenue',

  'Walmart',
  'Wawa',
  'Target',
  'Home Depot',
  'Lowes',
  'Rite Aid',
  'CVS',
  'Walgreens',
  'ShopRite',
  'Acme',
  'Dollar General',
  'Dollar Tree',
  'Family Dollar',
  'McDonalds',
  'Dunkin Donuts',
  'Popeyes',
  'Citizens Bank Park',
  'Lincoln Financial Field',
  'Wells Fargo Center',
  'Temple University',
  'University of Pennsylvania',
  'Drexel University',
  'Philadelphia International Airport',
  'Penn Medicine',
  'Jefferson Hospital',
  'Temple Hospital',
  'Einstein Medical Center',
  'Frankford Hospital',
  'Hahnemann',
  'City Hall',
  'Reading Terminal Market',
  'Convention Center',
  'Penns Landing',
  'FDR Park',
  'Fairmount Park',
  'Rittenhouse Square',
  'Love Park',
  'Kensington',
  'Fishtown',
  'Northern Liberties',
  'Port Richmond',
  'Bridesburg',
  'Tacony',
  'Mayfair',
  'Holmesburg',
  'Fox Chase',
  'Roxborough',
  'Manayunk',
  'East Falls',
  'Germantown',
  'Mount Airy',
  'Chestnut Hill',
  'Olney',
  'Logan',
  'Feltonville',
  'Juniata',
  'Frankford',
  'Wissinoming',
  'Somerton',
  'Bustleton',
  'Rhawnhurst',
  'Overbrook',
  'Wynnefield',
  'West Philadelphia',
  'North Philadelphia',
  'South Philadelphia',
  'Center City',
  'Southwest Philadelphia',
  'Northeast Philadelphia',
  'Point Breeze',
  'Grays Ferry',
  'Eastwick',
  'Elmwood',
  'Whitman',
  'Pennsport',
  'Queen Village',
  'Bella Vista',
  'Passyunk Square',

  'Boulevard',
  'Avenue',
  'Street',
  'Drive',
  'Lane',
  'Road',
  'Place',
  'Court',
  'Circle',
  'Parkway',
  'Highway',
  'Terrace',
  'Way',
  'North',
  'South',
  'East',
  'West',
  'Northeast',
  'Northwest',
  'Southeast',
  'Southwest',
  'Philadelphia',
  'Philly',
  'intersection',
  'block',

  'hundred',
  'hundred block',
  'thousand',
  'one hundred',
  'two hundred',
  'three hundred',
  'four hundred',
  'five hundred',
  'six hundred',
  'seven hundred',
  'eight hundred',
  'nine hundred',
  'one thousand',
  'two thousand',
  'three thousand',
  'four thousand',
  'five thousand',
  'six thousand',
  'seven thousand',
  'eight thousand',
  'nine thousand',
  'ten thousand',
  'eleven hundred',
  'twelve hundred',
  'thirteen hundred',
  'fourteen hundred',
  'fifteen hundred',
  'sixteen hundred',
  'seventeen hundred',
  'eighteen hundred',
  'nineteen hundred'
];

export function isConfigured() {
  return !!(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION);
}

function extractPcmFromWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return buffer;
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF') return buffer;
  if (buffer.slice(8, 12).toString('ascii') !== 'WAVE') return buffer;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return buffer.slice(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1;
  }
  return buffer.slice(44);
}

export async function speechToText(audioBuffer, options = {}) {
  if (!isConfigured()) throw new Error('Azure Speech not configured');
  return withV3Stage('speech_sdk_recognition', options.timeoutMs || V3_DEADLINES.transcriptionMs,
    ({ signal }) => new Promise((resolve, reject) => {
      let recognizer = null;
      let stream = null;
      let done = false;
      let stopping = false;
      const timers = new Set();
      const segments = [];
      let heardSpeech = false;
      const arm = (fn, ms) => {
        const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };
      const clearTimers = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      };
      const finish = (error = null) => {
        if (done) return;
        done = true;
        clearTimers();
        signal.removeEventListener('abort', canceled);
        try { recognizer?.close(); } catch (_) {}
        try { stream?.close(); } catch (_) {}
        if (error) reject(error);
        else resolve(segments.join(' ').trim());
      };
      const canceled = () => finish(new Error('Speech recognition canceled or deadline exceeded'));
      signal.addEventListener('abort', canceled, { once: true });
      const stop = () => {
        if (done || stopping) return;
        stopping = true;
        clearTimers();
        // SDK callbacks are not guaranteed to fire after a connection loss.
        arm(() => finish(new Error('Speech SDK stop callback deadline exceeded')), V3_DEADLINES.sdkStopMs);
        try {
          recognizer.stopContinuousRecognitionAsync(
            () => finish(),
            (error) => finish(error instanceof Error ? error : new Error(String(error))),
          );
        } catch (error) { finish(error); }
      };
      const resetSilence = () => {
        if (done || stopping) return;
        clearTimers();
        arm(stop, SILENCE_TIMEOUT_MS);
        arm(stop, SESSION_GUARD_TIMEOUT_MS);
      };
      try {
        if (signal.aborted) return canceled();
        const config = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
        config.speechRecognitionLanguage = 'en-US';
        stream = sdk.AudioInputStream.createPushStream(
          sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1),
        );
        stream.write(extractPcmFromWav(audioBuffer));
        stream.close();
        const audioConfig = sdk.AudioConfig.fromStreamInput(stream);
        recognizer = new sdk.SpeechRecognizer(config, audioConfig);
        const phrases = sdk.PhraseListGrammar.fromRecognizer(recognizer);
        for (const phrase of PHRASE_LIST) phrases.addPhrase(phrase);
        recognizer.recognized = (_sender, event) => {
          if (done || stopping) return;
          if (event.result.reason === sdk.ResultReason.RecognizedSpeech && event.result.text) {
            segments.push(event.result.text);
            heardSpeech = true;
            resetSilence();
          } else if (event.result.reason === sdk.ResultReason.NoMatch && heardSpeech) resetSilence();
        };
        recognizer.speechStartDetected = () => {
          if (done || stopping) return;
          heardSpeech = true;
          resetSilence();
        };
        recognizer.canceled = (_sender, event) => {
          if (done) return;
          if (event.reason === sdk.CancellationReason.EndOfStream) stop();
          else finish(new Error('Speech recognition canceled: ' + String(event.errorDetails || event.reason)));
        };
        recognizer.sessionStopped = stop;
        arm(stop, NO_SPEECH_TIMEOUT_MS);
        arm(stop, SESSION_GUARD_TIMEOUT_MS);
        recognizer.startContinuousRecognitionAsync(
          () => {},
          (error) => finish(error instanceof Error ? error : new Error(String(error))),
        );
      } catch (error) { finish(error); }
    }), { signal: options.signal });
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberToWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  return String(n);
}

function prepareForTTS(text) {
  return text.replace(/\b10[-\/](\d{1,3})\b/g, (match, num) => {
    return 'ten ' + numberToWords(parseInt(num, 10));
  });
}

export async function textToSpeech(text, options = {}) {
  if (!isConfigured()) throw new Error('Azure Speech not configured');
  const ttsText = prepareForTTS(text);
  return withV3Stage('speech_sdk_synthesis', options.timeoutMs || V3_DEADLINES.synthesisMs,
    ({ signal }) => new Promise((resolve, reject) => {
      let synthesizer = null;
      let finished = false;
      const finish = (error = null, audio = null) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', canceled);
        try { synthesizer?.close(); } catch (_) {}
        if (error) reject(error);
        else resolve(audio);
      };
      const canceled = () => finish(new Error('Speech synthesis canceled or deadline exceeded'));
      signal.addEventListener('abort', canceled, { once: true });
      try {
        if (signal.aborted) return canceled();
        const config = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
        config.speechSynthesisVoiceName = process.env.AI_DISPATCHER_VOICE || 'en-US-GuyNeural';
        config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;
        synthesizer = new sdk.SpeechSynthesizer(config, null);
        synthesizer.speakTextAsync(
          ttsText,
          (result) => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) finish(null, Buffer.from(result.audioData));
            else finish(new Error('TTS failed: ' + String(result.errorDetails)));
          },
          (error) => finish(error instanceof Error ? error : new Error(String(error))),
        );
      } catch (error) { finish(error); }
    }), { signal: options.signal });
}
