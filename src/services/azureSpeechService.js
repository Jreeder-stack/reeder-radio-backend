import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'eastus';

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
  'clear'
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

      recognizer.recognizeOnceAsync(
        (result) => {
          recognizer.close();
          if (result.reason === sdk.ResultReason.RecognizedSpeech) {
            resolve(result.text);
          } else if (result.reason === sdk.ResultReason.NoMatch) {
            resolve('');
          } else {
            resolve('');
          }
        },
        (error) => {
          recognizer.close();
          reject(error);
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
