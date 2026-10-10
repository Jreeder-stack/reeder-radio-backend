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
  $('tone').onclick=()=>safe(playOutputTest);
  $('start').onclick=()=>safe(startTest);$('stop').onclick=stopTest;
  window.addEventListener('beforeunload',stopTest);
});
