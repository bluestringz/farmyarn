// public/js/music.js
//
// ===================================================================
// HOW TO REPLACE THE MUSIC WITH YOUR OWN SONG
// ===================================================================
// Just drop an MP3 file here:
//
//     public/assets/music/theme.mp3
//
// That's it — on the next page load, the game will play YOUR file
// instead of the built-in generated tune. No code changes needed.
// If that file doesn't exist (or fails to load), it automatically
// falls back to the procedural chiptune loop below.
// ===================================================================
//
// Browsers block audio until a user gesture, so start()/toggle() are
// called from a click (the mute button, or the first tap on the page)
// rather than automatically on page load — see main.js's initMusic().

const FarmMusic = (() => {
  let ctx = null;
  let playing = false;
  let muted = localStorage.getItem('fy_music_muted') === '1';
  let nextLoopTimer = null;
  let masterGain = null;

  // ---- Real audio file playback (preferred, if the file exists) ----
  const CUSTOM_TRACK_URL = '/assets/music/theme.mp3';
  let customAudio = null;
  let customTrackAvailable = null; // null = not checked yet, true/false once known

  function tryLoadCustomTrack() {
    return new Promise((resolve) => {
      const audio = new Audio(CUSTOM_TRACK_URL);
      audio.loop = true;
      audio.volume = 0.5;
      audio.addEventListener('canplaythrough', () => resolve(audio), { once: true });
      audio.addEventListener('error', () => resolve(null), { once: true });
      audio.load();
    });
  }

  // ---- Procedural fallback tune (used if no custom file is present) ----
  // Cheerful C-major pentatonic loop, two bars of eighth notes — bright and
  // bouncy, in the spirit of an old browser-game jingle. Loops seamlessly.
  const NOTE = { C3: 130.81, G3: 196.00, C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.00, A4: 440.00, C5: 523.25 };
  const MELODY = [NOTE.E4, NOTE.G4, NOTE.A4, NOTE.G4, NOTE.E4, NOTE.D4, NOTE.C4, NOTE.D4,
                  NOTE.E4, NOTE.G4, NOTE.A4, NOTE.C5, NOTE.A4, NOTE.G4, NOTE.E4, NOTE.D4];
  const BASS = [NOTE.C3, null, NOTE.C3, null, NOTE.G3, null, NOTE.C3, null,
                NOTE.C3, null, NOTE.C3, null, NOTE.G3, null, NOTE.C3, null];
  const STEP_SECONDS = 0.24;
  const LOOP_SECONDS = STEP_SECONDS * MELODY.length;

  function ensureContext() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      masterGain = ctx.createGain();
    }
    return ctx;
  }

  function pluck(freq, startTime, duration, gainPeak, type) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  function scheduleLoop() {
    if (!playing) return;
    const loopStart = ctx.currentTime + 0.05;
    MELODY.forEach((freq, i) => {
      pluck(freq, loopStart + i * STEP_SECONDS, STEP_SECONDS * 0.9, 0.09, 'triangle');
    });
    BASS.forEach((freq, i) => {
      if (freq) pluck(freq, loopStart + i * STEP_SECONDS, STEP_SECONDS * 1.8, 0.07, 'sine');
    });
    nextLoopTimer = setTimeout(scheduleLoop, LOOP_SECONDS * 1000);
  }

  async function start() {
    if (muted || playing) return;
    try {
      if (customTrackAvailable === null) {
        customAudio = await tryLoadCustomTrack();
        customTrackAvailable = !!customAudio;
      }
      if (muted || playing) return; // state may have changed while awaiting the load

      if (customTrackAvailable) {
        await customAudio.play();
        playing = true;
        return;
      }

      // fall back to the procedural tune
      ensureContext();
      if (ctx.state === 'suspended') ctx.resume();
      masterGain.gain.value = 0.5;
      masterGain.connect(ctx.destination);
      playing = true;
      scheduleLoop();
    } catch (e) {
      console.warn('FarmMusic: audio unavailable', e);
    }
  }

  function stop() {
    playing = false;
    if (customAudio) customAudio.pause();
    if (nextLoopTimer) clearTimeout(nextLoopTimer);
    if (masterGain) {
      try { masterGain.disconnect(); } catch (e) { /* already disconnected */ }
    }
  }

  function toggle() {
    muted = !muted;
    localStorage.setItem('fy_music_muted', muted ? '1' : '0');
    if (muted) stop();
    else start();
    return !muted; // returns true if now playing
  }

  function isMuted() {
    return muted;
  }

  return { start, stop, toggle, isMuted };
})();

window.FarmMusic = FarmMusic;
