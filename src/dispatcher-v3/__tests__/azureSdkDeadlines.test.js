import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({recognizers:[],synths:[]}));
vi.mock('microsoft-cognitiveservices-speech-sdk',()=>({
  SpeechConfig:{fromSubscription:()=>({})},
  AudioInputStream:{createPushStream:()=>({write:vi.fn(),close:vi.fn()})},
  AudioStreamFormat:{getWaveFormatPCM:()=>({})},
  AudioConfig:{fromStreamInput:()=>({})},
  PhraseListGrammar:{fromRecognizer:()=>({addPhrase:vi.fn()})},
  ResultReason:{RecognizedSpeech:1,NoMatch:2,SynthesizingAudioCompleted:3},
  CancellationReason:{EndOfStream:1,Error:2},
  SpeechSynthesisOutputFormat:{Raw16Khz16BitMonoPcm:1},
  SpeechRecognizer:class {
    constructor(){this.close=vi.fn();this.stopContinuousRecognitionAsync=vi.fn();this.startContinuousRecognitionAsync=vi.fn((ok)=>ok());state.recognizers.push(this);}
  },
  SpeechSynthesizer:class {
    constructor(){this.close=vi.fn();this.speakTextAsync=vi.fn();state.synths.push(this);}
  },
}));
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-28T17:00:00.000Z'));vi.stubEnv('AZURE_SPEECH_KEY','fake-key');vi.stubEnv('AZURE_SPEECH_REGION','eastus');state.recognizers.length=0;state.synths.length=0;});
afterEach(()=>{expect(vi.getTimerCount()).toBe(0);vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs();});
const observe=p=>{const out={settled:false,value:null,error:null};out.done=p.then(v=>{out.settled=true;out.value=v;},e=>{out.settled=true;out.error=e;});return out;};
describe('01-04 Azure SDK callback lifetimes with synthetic SDK',()=>{
  it('bounds a stop callback that never fires and closes the recognizer once',async()=>{
    const service=await import('../../services/azureSpeechService.js');
    const turn=observe(service.speechToText(Buffer.alloc(640)));
    await vi.advanceTimersByTimeAsync(5050);
    expect(state.recognizers).toHaveLength(1);
    expect(state.recognizers[0].stopContinuousRecognitionAsync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2600);
    await turn.done;
    expect(turn.error).toMatchObject({message:expect.stringContaining('stop callback deadline')});
    expect(state.recognizers[0].close).toHaveBeenCalledTimes(1);
  });
  it('times out a never-calling TTS SDK and closes the synthesizer',async()=>{
    const service=await import('../../services/azureSpeechService.js');
    const turn=observe(service.textToSpeech('A1, copy'));
    await vi.advanceTimersByTimeAsync(12100);
    await turn.done;
    expect(turn.error).toMatchObject({code:'OPERATION_TIMEOUT'});
    expect(state.synths[0].close).toHaveBeenCalledTimes(1);
  });
  it('honors an external abort and rejects any late SDK completion',async()=>{
    const service=await import('../../services/azureSpeechService.js');
    const ctrl=new AbortController();
    const turn=observe(service.textToSpeech('A1, copy',{signal:ctrl.signal}));
    await Promise.resolve();await Promise.resolve();
    ctrl.abort();await turn.done;
    expect(turn.error).toMatchObject({code:'OPERATION_TIMEOUT'});
    const synth=state.synths[0];
    synth.speakTextAsync.mock.calls[0][1]({reason:3,audioData:new Uint8Array([1])});
    expect(turn.value).toBe(null);
    expect(synth.close).toHaveBeenCalledTimes(1);
  });
});
