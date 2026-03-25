import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

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

export async function speechToText(audioBuffer) {
  if (!isConfigured()) {
    throw new Error('Azure Speech not configured');
  }

  return new Promise((resolve, reject) => {
    try {
      const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = 'en-US';

      const pushStream = sdk.AudioInputStream.createPushStream(
        sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1)
      );
      pushStream.write(audioBuffer);
      pushStream.close();

      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      const phraseList = sdk.PhraseListGrammar.fromRecognizer(recognizer);
      for (const phrase of PHRASE_LIST) {
        phraseList.addPhrase(phrase);
      }

      const segments = [];
      let silenceTimer = null;
      let guardTimer = null;
      let noSpeechTimer = null;
      let settled = false;
      let heardSpeech = false;

      function settle() {
        if (settled) return;
        settled = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        if (guardTimer) clearTimeout(guardTimer);
        if (noSpeechTimer) clearTimeout(noSpeechTimer);
        recognizer.stopContinuousRecognitionAsync(
          () => {
            recognizer.close();
            const transcript = segments.join(' ').trim();
            resolve(transcript);
          },
          (err) => {
            recognizer.close();
            resolve(segments.join(' ').trim());
          }
        );
      }

      function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => settle(), SILENCE_TIMEOUT_MS);
      }

      recognizer.recognized = (_sender, event) => {
        if (event.result.reason === sdk.ResultReason.RecognizedSpeech && event.result.text) {
          segments.push(event.result.text);
          if (!heardSpeech) {
            heardSpeech = true;
            if (noSpeechTimer) clearTimeout(noSpeechTimer);
          }
          resetSilenceTimer();
        } else if (event.result.reason === sdk.ResultReason.NoMatch && heardSpeech) {
          resetSilenceTimer();
        }
      };

      recognizer.speechStartDetected = () => {
        if (!heardSpeech) {
          heardSpeech = true;
          if (noSpeechTimer) clearTimeout(noSpeechTimer);
        }
        resetSilenceTimer();
      };

      recognizer.canceled = (_sender, event) => {
        if (event.reason === sdk.CancellationReason.EndOfStream) {
          settle();
        } else if (event.reason === sdk.CancellationReason.Error) {
          if (!settled) {
            settled = true;
            if (silenceTimer) clearTimeout(silenceTimer);
            if (guardTimer) clearTimeout(guardTimer);
            if (noSpeechTimer) clearTimeout(noSpeechTimer);
            recognizer.close();
            if (segments.length > 0) {
              resolve(segments.join(' ').trim());
            } else {
              reject(new Error(`Speech recognition canceled: ${event.errorDetails}`));
            }
          }
        }
      };

      recognizer.sessionStopped = () => {
        settle();
      };

      noSpeechTimer = setTimeout(() => settle(), NO_SPEECH_TIMEOUT_MS);
      guardTimer = setTimeout(() => settle(), SESSION_GUARD_TIMEOUT_MS);

      recognizer.startContinuousRecognitionAsync(
        () => {},
        (error) => {
          if (!settled) {
            settled = true;
            if (silenceTimer) clearTimeout(silenceTimer);
            if (guardTimer) clearTimeout(guardTimer);
            if (noSpeechTimer) clearTimeout(noSpeechTimer);
            recognizer.close();
            reject(error);
          }
        }
      );
    } catch (error) {
      reject(error);
    }
  });
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

export async function textToSpeech(text) {
  if (!isConfigured()) {
    throw new Error('Azure Speech not configured');
  }

  const ttsText = prepareForTTS(text);

  return new Promise((resolve, reject) => {
    try {
      const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
      speechConfig.speechSynthesisVoiceName = process.env.AI_DISPATCHER_VOICE || 'en-US-GuyNeural';
      speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;

      const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);

      synthesizer.speakTextAsync(
        ttsText,
        (result) => {
          synthesizer.close();
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve(Buffer.from(result.audioData));
          } else {
            reject(new Error(`TTS failed: ${result.errorDetails}`));
          }
        },
        (error) => {
          synthesizer.close();
          reject(error);
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}
