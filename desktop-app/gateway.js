'use strict';
const $ = (id) => document.getElementById(id);
let stream = null, context = null, source = null, analyzer = null, raf = 0;
let selected = { inputId: '', outputId: '' };
const safe = (fn) => fn().catch((error) => { $('status').textContent = error.message || String(error); });
async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [id, kind, current] of [['input','audioinput',selected.inputId],['output','audiooutput',selected.outputId]]) {
    const select = $(id); select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value=''; placeholder.textContent='Select a USB sound card '+(id === 'input' ? 'input' : 'output'); select.append(placeholder);
    for(const device of devices.filter((d)=>d.kind===kind)){
      const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label||('Audio device '+select.options.length);select.append(option);
    }
    if([...select.options].some((option)=>option.value===current)) select.value=current;
  }
}
function stopTest(){
  cancelAnimationFrame(raf);raf=0;
  if(source){source.disconnect();source=null;}
  if(stream){stream.getTracks().forEach((track)=>track.stop());stream=null;}
  if(context){context.close().catch(()=>{});context=null;}
  analyzer=null;$('level').value=0;$('start').disabled=false;$('stop').disabled=true;
  $('status').textContent='Gateway inactive — RF transmit disabled.';
}
async function startTest(){
  stopTest();
  if(!$('input').value)throw new Error('Select a USB microphone input first.');
  stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:$('input').value},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
  context=new AudioContext();source=context.createMediaStreamSource(stream);analyzer=context.createAnalyser();analyzer.fftSize=1024;source.connect(analyzer);
  // Deliberately never connect analyzer to speakers: avoids local audio feedback.
  const data=new Float32Array(analyzer.fftSize);
  $('start').disabled=true;$('stop').disabled=false;$('status').textContent='Monitoring USB radio receive audio only.';
  const tick=()=>{
    if(!analyzer)return;
    analyzer.getFloatTimeDomainData(data);let sum=0;for(const s of data)sum+=s*s;
    const rms=Math.sqrt(sum/data.length);$('level').value=Math.min(100,Math.round(rms*250));
    raf=requestAnimationFrame(tick);
  };tick();
}
async function playOutputTest() {
  if (!$('txConfirm').checked) throw new Error('Confirm the SR-629 is OFF before testing USB output.');
  const outputId = $('output').value;
  if (!outputId) throw new Error('Choose the USB headphone output first.');
  const testContext = new AudioContext();
  const destination = testContext.createMediaStreamDestination();
  const oscillator = testContext.createOscillator();
  const gain = testContext.createGain();
  oscillator.frequency.value = 650;
  gain.gain.value = 0.008;
  oscillator.connect(gain).connect(destination);
  const audio = new Audio();
  audio.srcObject = destination.stream;
  try {
    if (typeof audio.setSinkId !== 'function') throw new Error('This desktop audio runtime cannot select an output device.');
    await audio.setSinkId(outputId);
    await audio.play();
    oscillator.start();
    $('status').textContent = '1-second USB output test in progress (SR-629 must remain OFF).';
    await new Promise(resolve => setTimeout(resolve, 1000));
    oscillator.stop();
    $('status').textContent = 'Output tone completed. RF gateway remains disabled.';
  } finally {
    try { oscillator.stop(); } catch (_) {}
    audio.pause(); audio.srcObject = null;
    destination.stream.getTracks().forEach(track => track.stop());
    await testContext.close();
  }
}

let networkChannel = '', gatewayTx = false, radioOutput = null, playCursor = 0;
let txProcessor = null, txBuffer = [], txSequence = 0, txTimeout = null;
let stoppingTx = false, pttHeld = false;
async function loadGatewayChannels() {
  const list = await window.electronAPI.fetchGatewayChannels();
  const select = $('channel'); select.replaceChildren();
  const blank = document.createElement('option'); blank.value=''; blank.textContent='Choose a channel'; select.append(blank);
  if (!Array.isArray(list)) return;
  for(const ch of list) {
    const option=document.createElement('option');
    option.value=ch.room_key || ((ch.zone || 'Default')+'__'+ch.name);
    option.textContent=ch.name+' ('+(ch.zone||'Default')+')';
    select.append(option);
  }
}
async function connectChannel(){
  if(!$('channel').value)throw new Error('Select a channel.');
  await disconnectChannel();
  $('networkStatus').textContent='Connecting...';
  const result=await window.electronAPI.connectGateway($('channel').value);
  if(!result.success)throw new Error(result.error || 'Connection failed');
  networkChannel=$('channel').value;
  $('networkStatus').textContent='Connected to '+networkChannel+' (receive output disabled)';
  $('connect').disabled=true;$('disconnect').disabled=false;
  $('rxEnable').disabled=false;$('ptt').disabled=false;$('channel').disabled=true;
}
async function disableOutput(){
  if(radioOutput){
    const old=radioOutput;radioOutput=null;old.element.pause();old.element.srcObject=null;
    old.dest.stream.getTracks().forEach(track=>track.stop());await old.context.close().catch(()=>{});
  }
  playCursor=0;$('rxEnable').disabled=!networkChannel;$('rxDisable').disabled=true;
}
async function enableOutput(){
  if(!networkChannel)throw new Error('Connect a channel first.');
  if(!$('radioOutputConfirm').checked)throw new Error('Confirm authorization before enabling radio output.');
  if(!$('output').value)throw new Error('Select a USB output first.');
  await disableOutput();
  const context=new AudioContext({sampleRate:16000});
  const dest=context.createMediaStreamDestination();
  const element=new Audio();element.srcObject=dest.stream;
  try{
    if(typeof element.setSinkId!=='function')throw Error('Selected audio output routing is not supported.');
    await element.setSinkId($('output').value);
    await element.play();await context.resume();
    radioOutput={context,dest,element};
    playCursor=context.currentTime+0.08;
    $('rxEnable').disabled=true;$('rxDisable').disabled=false;
    $('networkStatus').textContent='Connected: channel audio is playing to selected USB output.';
  }catch(error){
    element.pause();element.srcObject=null;dest.stream.getTracks().forEach(t=>t.stop());
    await context.close().catch(()=>{});throw error;
  }
}
function playIncomingFrame(data){
  if(!radioOutput || !networkChannel || !data || !Array.isArray(data.bytes))return;
  const bytes=data.bytes;if(bytes.length<10 || bytes[0]!==1)return;
  const chLen=bytes[5], afterCh=6+chLen;if(afterCh>=bytes.length)return;
  const channel=new TextDecoder().decode(new Uint8Array(bytes.slice(6,afterCh)));
  if(channel!==networkChannel)return;
  const senderLen=bytes[afterCh], pcmOffset=afterCh+1+senderLen;
  const remaining=bytes.length-pcmOffset;
  if(remaining<2 || remaining%2!==0 || remaining>3840)return;
  const {context,dest}=radioOutput;
  const samples=remaining/2;
  const audio=context.createBuffer(1,samples,16000);
  const floats=audio.getChannelData(0);
  for(let i=0;i<samples;i++){
    const v=bytes[pcmOffset+i*2]|(bytes[pcmOffset+i*2+1]<<8);
    floats[i]=((v&0x8000)?v-65536:v)/32768;
  }
  if(playCursor<context.currentTime || playCursor>context.currentTime+0.6)playCursor=context.currentTime+0.08;
  const node=context.createBufferSource();node.buffer=audio;node.connect(dest);
  node.start(playCursor);playCursor+=samples/16000;
  node.onended=()=>{try{node.disconnect()}catch(_){}};
}
function shutdownTxProcessor(){
  if(txTimeout){clearTimeout(txTimeout);txTimeout=null;}
  if(txProcessor){txProcessor.onaudioprocess=null;txProcessor.disconnect();if(txProcessor._silent)txProcessor._silent.disconnect();txProcessor=null;}
  txBuffer=[];
}
async function stopPtt(){
  pttHeld=false;
  if(stoppingTx)return;stoppingTx=true;
  gatewayTx=false;shutdownTxProcessor();
  $('ptt').disabled=!networkChannel;$('ptt').textContent='Hold to send radio input to channel (max 10s)';
  await window.electronAPI.endGatewayPtt().catch(()=>{});
  stoppingTx=false;
}
async function beginPtt(){
  if(!networkChannel || gatewayTx || stoppingTx)return;
  if(!stream || !source || !context)throw Error('Start the USB receive-input meter first.');
  // Ensure the audio stream is actually routed from the selected USB microphone.
  const currentTrack=stream.getAudioTracks()[0];
  if(!currentTrack || currentTrack.readyState!=='live')throw Error('Radio audio input unavailable');
  $('ptt').disabled=true;
  const result=await window.electronAPI.startGatewayPtt();
  if(!pttHeld){await window.electronAPI.endGatewayPtt().catch(()=>{});$('ptt').disabled=false;return;}
  if(!result.success){$('ptt').disabled=false;throw Error(result.error || 'PTT denied');}
  gatewayTx=true;txSequence=0;txBuffer=[];
  txProcessor=context.createScriptProcessor(1024,1,1);
  const actualRate=context.sampleRate;
  txProcessor.onaudioprocess=e=>{
    if(!gatewayTx)return;
    const input=e.inputBuffer.getChannelData(0);
    // Mono resampling from the active AudioContext rate to the network's 16 kHz PCM format.
    const samples=Math.max(1,Math.floor(input.length*16000/actualRate));
    for(let j=0;j<samples;j++){
      const sample=input[Math.min(input.length-1,Math.floor(j*actualRate/16000))];
      const clamped=Math.max(-1,Math.min(1,sample));
      txBuffer.push(clamped<0?Math.round(clamped*32768):Math.round(clamped*32767));
    }
    while(txBuffer.length>=320){
      const frame=txBuffer.splice(0,320),bytes=[];
      for(const sample of frame){bytes.push(sample&255,(sample>>8)&255);}
      window.electronAPI.sendGatewayPcm(bytes,txSequence++);
    }
  };
  source.connect(txProcessor);
  const silent=context.createGain();silent.gain.value=0;txProcessor.connect(silent);silent.connect(context.destination);
  txProcessor._silent=silent;
  txTimeout=setTimeout(()=>stopPtt().catch(()=>{}),10000);
  $('ptt').textContent='TRANSMITTING — release to stop (10-second limit)';
}
async function disconnectChannel(){
  await stopPtt();await disableOutput();
  await window.electronAPI.disconnectGateway().catch(()=>{});
  networkChannel='';$('networkStatus').textContent='Not connected';
  $('connect').disabled=false;$('disconnect').disabled=true;
  $('rxEnable').disabled=true;$('rxDisable').disabled=true;$('ptt').disabled=true;$('channel').disabled=false;
}

document.addEventListener('DOMContentLoaded',async()=>{
  try{selected=await window.electronAPI.getGatewaySettings();await listDevices();}
  catch(error){$('status').textContent='Unable to enumerate audio devices: '+error.message;}
  $('refresh').onclick=()=>safe(listDevices);
  $('save').onclick=()=>safe(async()=>{const inputId=$('input').value,outputId=$('output').value;
    if(!inputId||!outputId)throw new Error('Select both USB sound-card ports.');
    if(inputId===outputId)throw new Error('Input and output must be different audio endpoints.');
    const result=await window.electronAPI.saveGatewaySettings({inputId,outputId});
    if(!result.success)throw new Error(result.error);selected={inputId,outputId};
    $('status').textContent='USB device selection saved. RF transmission remains disabled.';
  });
  safe(loadGatewayChannels);
  $('connect').onclick=()=>safe(connectChannel);
  $('disconnect').onclick=()=>safe(disconnectChannel);
  $('rxEnable').onclick=()=>safe(enableOutput);
  $('rxDisable').onclick=()=>safe(disableOutput);
  $('ptt').addEventListener('pointerdown',e=>{e.preventDefault();pttHeld=true;e.currentTarget.setPointerCapture(e.pointerId);safe(beginPtt);});
  for(const evt of ['pointerup','pointercancel','pointerleave']) $('ptt').addEventListener(evt,()=>safe(stopPtt));
  window.addEventListener('blur',()=>safe(stopPtt));
  window.electronAPI.onGatewayAudio(data=>{
    if(data.type==='audio')playIncomingFrame(data);
    else if(data.type==='disconnected'||data.type==='error'){
      gatewayTx=false;shutdownTxProcessor();
      safe(disconnectChannel);
      $('networkStatus').textContent='Network disconnected — gateway stopped';
    }
  });
  $('tone').onclick=()=>safe(playOutputTest);
  $('start').onclick=()=>safe(startTest);$('stop').onclick=stopTest;
  window.addEventListener('beforeunload',()=>{
    gatewayTx=false;shutdownTxProcessor();
    window.electronAPI.endGatewayPtt().catch(()=>{});
    window.electronAPI.disconnectGateway().catch(()=>{});
    disableOutput().catch(()=>{});
    stopTest();
  });
});
