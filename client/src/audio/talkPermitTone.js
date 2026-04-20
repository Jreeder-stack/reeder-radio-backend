import { getSharedAudioContext } from './iosAudioUnlock.js';

let permitBuffer = null;
let preloadPromise = null;

function getPermitContext() {
  return getSharedAudioContext();
}

export function preloadPermitBuffer() {
  if (permitBuffer) return Promise.resolve(permitBuffer);
  if (preloadPromise) return preloadPromise;

  var ctx = getPermitContext();
  preloadPromise = fetch('/sounds/talk-permit.wav')
    .then(function (res) { return res.arrayBuffer(); })
    .then(function (buf) { return ctx.decodeAudioData(buf); })
    .then(function (decoded) {
      permitBuffer = decoded;
      console.log('[TalkPermit] WAV preloaded');
      return decoded;
    })
    .catch(function (e) {
      console.warn('[TalkPermit] WAV preload failed:', e.message);
      preloadPromise = null;
      return null;
    });

  return preloadPromise;
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
    gain.gain.setValueAtTime(0.6, startTime);
    gain.gain.setValueAtTime(0, startTime + beepDuration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + beepDuration);
  }
}

export function playPermitTone() {
  return (async function () {
    try {
      var ctx = getPermitContext();

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      if (!permitBuffer) {
        var loadPromise = preloadPermitBuffer();
        if (loadPromise) {
          var result = await Promise.race([
            loadPromise,
            new Promise(function (resolve) {
              setTimeout(function () { resolve('__timeout__'); }, 500);
            })
          ]);
          if (result === '__timeout__') {
            console.warn('[TalkPermit] WAV load timed out after 500ms, using fallback');
            preloadPromise = null;
          }
        }
      }

      if (permitBuffer) {
        var source = ctx.createBufferSource();
        source.buffer = permitBuffer;
        var gain = ctx.createGain();
        gain.gain.value = 0.6;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
        var duration = permitBuffer.duration * 1000;
        var waitMs = Math.max(duration, 300);
        var safetyTimer = null;
        await Promise.race([
          Promise.all([
            new Promise(function (resolve) {
              source.onended = function () { resolve(); };
            }),
            new Promise(function (resolve) {
              setTimeout(resolve, waitMs);
            })
          ]).then(function () {
            clearTimeout(safetyTimer);
          }),
          new Promise(function (resolve) {
            safetyTimer = setTimeout(function () {
              console.warn('[TalkPermit] Safety timeout reached, proceeding after', waitMs + 500, 'ms');
              resolve();
            }, waitMs + 500);
          })
        ]);
        return duration;
      } else {
        var beepDuration = 0.040;
        var gap = 0.030;
        var totalMs = (3 * beepDuration + 2 * gap) * 1000;
        playOscillatorFallback(ctx);
        await new Promise(function (resolve) {
          setTimeout(function () { resolve(totalMs); }, totalMs);
        });
        return totalMs;
      }
    } catch (e) {
      console.warn('[TalkPermit] Playback failed:', e.message);
      return 0;
    }
  })();
}

let bonkOscillator = null;
let bonkGain = null;
let bonkEpoch = 0;

function getBonkContext() {
  return getSharedAudioContext();
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
