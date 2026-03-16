let permitCtx = null;
let permitBuffer = null;
let bufferLoading = false;

function getPermitContext() {
  if (!permitCtx || permitCtx.state === 'closed') {
    permitCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return permitCtx;
}

export function preloadPermitBuffer() {
  if (permitBuffer || bufferLoading) return;
  bufferLoading = true;
  var ctx = getPermitContext();
  fetch('/sounds/talk-permit.wav')
    .then(function (res) { return res.arrayBuffer(); })
    .then(function (buf) { return ctx.decodeAudioData(buf); })
    .then(function (decoded) {
      permitBuffer = decoded;
      console.log('[TalkPermit] WAV preloaded');
    })
    .catch(function (e) {
      console.warn('[TalkPermit] WAV preload failed:', e.message);
      bufferLoading = false;
    });
}

function playOscillatorFallback(ctx) {
  var now = ctx.currentTime;
  var frequency = 800;
  var beepDuration = 0.040;
  var gap = 0.030;

  for (var i = 0; i < 3; i++) {
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequency;

    var gain = ctx.createGain();
    var startTime = now + i * (beepDuration + gap);
    gain.gain.setValueAtTime(0.4, startTime);
    gain.gain.setValueAtTime(0, startTime + beepDuration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + beepDuration);
  }
}

export function playPermitTone() {
  (async function () {
    try {
      var ctx = getPermitContext();

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      preloadPermitBuffer();

      if (permitBuffer) {
        var source = ctx.createBufferSource();
        source.buffer = permitBuffer;
        var gain = ctx.createGain();
        gain.gain.value = 0.6;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
      } else {
        playOscillatorFallback(ctx);
      }
    } catch (e) {
      console.warn('[TalkPermit] Playback failed:', e.message);
    }
  })();
}

let bonkOscillator = null;
let bonkGain = null;
let bonkCtx = null;
let bonkEpoch = 0;

function getBonkContext() {
  if (!bonkCtx || bonkCtx.state === 'closed') {
    bonkCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return bonkCtx;
}

export function startBonkLoop() {
  stopBonkLoop();

  var epoch = ++bonkEpoch;

  (async function () {
    try {
      var ctx = getBonkContext();

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      if (epoch !== bonkEpoch) return;

      bonkOscillator = ctx.createOscillator();
      bonkGain = ctx.createGain();

      bonkOscillator.type = 'sine';
      bonkOscillator.frequency.value = 400;

      bonkGain.gain.value = 0.3;

      bonkOscillator.connect(bonkGain);
      bonkGain.connect(ctx.destination);

      bonkOscillator.start();
    } catch (e) {
      console.warn('[TalkPermit] Bonk loop failed:', e.message);
    }
  })();
}

export function stopBonkLoop() {
  bonkEpoch++;
  if (bonkOscillator) {
    try {
      bonkOscillator.stop();
      bonkOscillator.disconnect();
    } catch (e) {}
    bonkOscillator = null;
  }
  if (bonkGain) {
    try {
      bonkGain.disconnect();
    } catch (e) {}
    bonkGain = null;
  }
}
