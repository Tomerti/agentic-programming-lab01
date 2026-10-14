// The game's sound (spec §8). Every effect and the room's hum is synthesized at runtime with the Web Audio API, from
// oscillators and noise through filters and gain envelopes: there are no audio files. play(name) plays a sound of
// SOUNDS, bind() plays them on the session's events, and main.js plays the console controls' and the HUD's.
//
// Nothing sounds before unlock(). Browsers let a page start its audio only on a user gesture, so the screens unlock it
// on the button that starts play, and createAudio makes no audio node before that. The mix: each sound plays through a
// gain of its own (the gain asked for, times the fall-off with distance) into a compressor that keeps a pile of
// explosions from clipping (TRIM takes back the gain it adds), then the master gain (the volume, or 0 when muted) and
// the speakers. The sounds' own peaks stay modest (explosions at most 0.8, the controls and the jingles 0.25, the hum
// 0.06), so the compressor has little to do.
//
// SOUNDS and startHum work on any audio context, an OfflineAudioContext too, so a check can render them.

const SILENT = 0.0001; // where an exponential ramp ends: it cannot reach 0
const LEAD = 0.01; // seconds: a sound starts this far ahead of the context's clock, so its first ramp is heard whole
// A sound `distance` world units from the window keeps 1 − distance / FALLOFF of its gain, never less than FAINTEST.
const FALLOFF = 40;
const FAINTEST = 0.25;
// The least time between two plays of a sound, in seconds: a burst of new tracks pings once, the low-resource beeps
// (which the HUD limits too) and the jamming warning keep 8 s apart, and a quick flick of switches clacks steadily.
const MIN_INTERVAL = Object.freeze({ ping: 0.15, warning: 8, clack: 0.06 });
// The sounds that a new one of their kind cuts short: another alert restarts the siren, another HQ call the ring.
const SINGLE = new Set(['siren', 'phone']);
const CUT = 0.02; // seconds: the time constant of that cut's fade
// The master compressor: a soft limiter that acts only when loud sounds pile up. dB, a ratio, seconds. It raises
// everything by a makeup gain of its own (about 1.28 with these settings), which TRIM, after it, takes back: a lone
// sound plays at its own level, and a pile of explosions tops out near 0.75.
const COMPRESSOR = Object.freeze({ threshold: -6, knee: 6, ratio: 12, attack: 0.001, release: 0.25 });
const TRIM = 0.78;
const VOLUME_GLIDE = 0.015; // seconds: the time constant of a volume or mute change, which would click if instant
const RESUME_WAIT = 1000; // ms: unlock() stops waiting for a context that does not start (no gesture) after this

// The siren: the two pitches it switches between (Hz), each held `step` seconds, sliding over the last `slide` of it.
// It sounds as long as the beacon spins (config TIMING.alertSiren).
const SIREN = Object.freeze({ high: 800, low: 600, step: 0.5, slide: 0.04, length: 4, peak: 0.075 });
// The phone: `rings` rings of `length` s, `gap` s apart, the clapper striking the two bells (their pitch in Hz and
// their share of the peak) `strikes` times a second.
const RING = Object.freeze({
  rings: 2, length: 0.4, gap: 0.2, strikes: 24, bells: [[1180, 0.6], [1630, 0.4]], peak: 0.2,
});
// The hum: its levels (the room's rumble, the 50 Hz mains and two harmonics, the vents' air) and its fades, in seconds.
const HUM = Object.freeze({
  room: 0.06,
  mains: [[50, 0.006], [100, 0.004], [150, 0.0015]],
  air: 0.006,
  fadeIn: 2.5,
  fadeOut: 0.6,
});
// A struck bar's partials, a glockenspiel's: [pitch ratio, share of the peak, share of the decay].
const BELL = [[1, 1, 1], [2.76, 0.35, 0.45], [5.4, 0.15, 0.25]];
// Equal-tempered pitches, in Hz. The jingles are in C major or A minor, so two that meet agree.
const NOTE = Object.freeze({
  A2: 110, A3: 220, C4: 261.63, E4: 329.63, G4: 392, A4: 440,
  C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5, E6: 1318.51,
});

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
// A random factor within ±amount of 1: no two explosions sound quite the same.
const vary = amount => 1 + (Math.random() * 2 - 1) * amount;
// The share of its gain a sound keeps at `distance` from the window (see FALLOFF); all of it when none is given.
const falloff = distance => (Number.isFinite(distance) ? clamp(1 - distance / FALLOFF, FAINTEST, 1) : 1);
// How far away a sound is, 0 (at the window) to 1 (FALLOFF away or more), for dulling it; 0 when none is given.
const farness = distance => (Number.isFinite(distance) ? clamp(distance / FALLOFF, 0, 1) : 0);

// --- Noise ---

const noises = new WeakMap(); // audio context → its noise buffers

// The context's noise buffers, made at their first use and shared by every sound: one second of white noise and five
// of brown noise (a random walk, which rumbles). The sounds loop them from a random point.
function noiseBuffers(ctx) {
  let buffers = noises.get(ctx);
  if (!buffers) {
    buffers = { white: whiteNoise(ctx, 1), brown: brownNoise(ctx, 5) };
    noises.set(ctx, buffers);
  }
  return buffers;
}

function whiteNoise(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// White noise summed with a slight leak (so that it cannot wander off), then tilted so that its ends meet (a loop of
// it does not click), centred on 0 and scaled to peak at 1.
function brownNoise(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let walk = 0;
  for (let i = 0; i < data.length; i++) {
    walk = (walk + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = walk;
  }
  const last = data.length - 1;
  const tilt = data[last] - data[0];
  let mean = 0;
  for (let i = 0; i <= last; i++) {
    data[i] -= (tilt * i) / last;
    mean += data[i] / data.length;
  }
  let peak = 0;
  for (let i = 0; i <= last; i++) {
    data[i] -= mean;
    peak = Math.max(peak, Math.abs(data[i]));
  }
  for (let i = 0; i <= last; i++) data[i] /= peak;
  return buffer;
}

// --- Voices ---

const ownOutputs = new WeakSet(); // the outputs that play() makes, one per sound played

// A voice: the nodes of one sound, built into `out`, with helpers for the usual parts. Every source starts and stops
// at a set time; once the last has stopped, every node of the voice is disconnected, and `out` too when play() made it
// for this sound. `end` is when its last source stops.
function voice(ctx, out) {
  const nodes = [];
  const sources = [];
  let stopped = 0;
  const v = { end: 0 };

  function ended() {
    stopped += 1;
    if (stopped < sources.length) return;
    for (const node of nodes) node.disconnect();
    if (ownOutputs.has(out)) out.disconnect();
  }

  const keep = node => {
    nodes.push(node);
    return node;
  };

  // Starts a source at `at` (`offset` seconds into its buffer) and, given an `end`, stops it then.
  function run(source, at, end = null, offset = 0) {
    keep(source);
    if (offset) source.start(at, offset);
    else source.start(at);
    if (end !== null) {
      source.stop(end);
      v.end = Math.max(v.end, end);
    }
    sources.push(source);
    source.onended = ended;
    return source;
  }

  // Stops every source at `when` (for a sound with no end of its own).
  function stop(when) {
    for (const source of sources) source.stop(when);
  }

  // Connects the nodes in a line, the last possibly an AudioParam, and returns the first. Missing ones are skipped.
  function line(...chain) {
    const linked = chain.filter(Boolean);
    for (let i = 1; i < linked.length; i++) linked[i - 1].connect(linked[i]);
    return linked[0];
  }

  function gain(value) {
    const node = keep(ctx.createGain());
    node.gain.value = value;
    return node;
  }

  // A biquad filter. q is its Q: for a lowpass or a highpass a resonance in dB (0, a slight bump at the cutoff, unless
  // given), for a bandpass the quality factor (1 unless given). With `to`, the cutoff sweeps (exponentially) from
  // `freq` at `at` to `to` over `sweep` seconds.
  function filter(type, freq, { q, at = 0, to = freq, sweep = 0.5 } = {}) {
    const node = keep(ctx.createBiquadFilter());
    node.type = type;
    node.Q.value = q ?? (type === 'bandpass' ? 1 : 0);
    node.frequency.value = freq;
    if (to !== freq) {
      node.frequency.setValueAtTime(freq, at);
      node.frequency.exponentialRampToValueAtTime(to, at + sweep);
    }
    return node;
  }

  // An envelope: silent until `at`, rising to `peak` over `attack` seconds, held for `hold`, then falling away
  // (exponentially) over `decay`. Returns the gain node and the time it falls silent.
  function envelope(at, { peak, attack = 0.002, hold = 0, decay }) {
    const node = gain(0);
    const top = at + attack + hold;
    const end = top + decay;
    node.gain.setValueAtTime(0, at);
    node.gain.linearRampToValueAtTime(peak, at + attack);
    if (hold > 0) node.gain.setValueAtTime(peak, top);
    node.gain.exponentialRampToValueAtTime(SILENT, end);
    node.gain.setValueAtTime(0, end);
    return { node, end };
  }

  function oscillator(type, freq, at, end) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.frequency.setValueAtTime(freq, at);
    return run(osc, at, end);
  }

  // Noise of a `color` ('white' or 'brown'), looped from a random point.
  function noiseSource(color, at, end) {
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffers(ctx)[color];
    source.loop = true;
    return run(source, at, end, Math.random() * source.buffer.duration);
  }

  // A tone: an oscillator of `type` at `freq` Hz, gliding (exponentially) to `to` over `glide` seconds (the whole
  // tone unless given), detuned by `detune` cents, through an optional filter ({ type, freq, q, to, sweep }, as
  // filter() takes) and an envelope (its peak, attack, hold and decay), into `into`. Returns the oscillator.
  function tone({ type = 'sine', freq, to = freq, glide, detune = 0, filter: shape = null, into = out, at, ...env }) {
    const { node, end } = envelope(at, env);
    const osc = oscillator(type, freq, at, end);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, at + (glide ?? end - at));
    if (detune) osc.detune.value = detune;
    line(osc, shape && filter(shape.type, shape.freq, { ...shape, at }), node, into);
    return osc;
  }

  // A noise burst: white noise (or brown, which rumbles) through a filter of `type` at `freq` Hz, sweeping
  // (exponentially) to `to` over `sweep` seconds (the whole burst unless given), and an envelope, into `into`.
  function noise({ color = 'white', type = 'lowpass', freq, to = freq, sweep, q, into = out, at, ...env }) {
    const { node, end } = envelope(at, env);
    line(noiseSource(color, at, end), filter(type, freq, { q, at, to, sweep: sweep ?? end - at }), node, into);
  }

  // A vibrato or tremolo: `param` swung by ±depth, `rate` times a second, from `at` to `end`.
  function wobble(param, { rate, depth, at, end }) {
    line(oscillator('sine', rate, at, end), gain(depth), param);
  }

  return Object.assign(v, { run, stop, line, gain, filter, envelope, oscillator, noiseSource, tone, noise, wobble });
}

// --- Instruments for the jingles ---

// A struck bar at `freq`: its partials (BELL) die away faster the higher they are.
function bell(v, at, freq, { peak, decay }) {
  for (const [ratio, share, length] of BELL) {
    v.tone({ freq: freq * ratio, at, peak: peak * share, attack: 0.002, decay: decay * length });
  }
}

// A brass note at `freq`: two sawtooths a few cents apart through a lowpass that opens as the note starts, the blare
// of a horn.
function brass(v, at, freq, { peak, hold, decay }) {
  const opening = { type: 'lowpass', freq: 500, to: 2400, sweep: 0.08, q: 2 };
  for (const detune of [-6, 6]) {
    v.tone({ type: 'sawtooth', freq, detune, filter: opening, at, peak: peak / 2, attack: 0.025, hold, decay });
  }
}

// A soft mallet note at `freq`: a sine with a faint octave over it.
function mallet(v, at, freq, { peak, decay }) {
  v.tone({ freq, at, peak, attack: 0.004, decay });
  v.tone({ freq: freq * 2, at, peak: peak * 0.18, attack: 0.003, decay: decay * 0.5 });
}

// A sombre note at `freq`: a triangle with a darkened sawtooth under it, sagging a little as it fades.
function sombre(v, at, freq, { peak, hold = 0, decay }) {
  const sag = freq * 0.985;
  v.tone({ type: 'triangle', freq, to: sag, at, peak, attack: 0.02, hold, decay });
  v.tone({ type: 'sawtooth', freq, to: sag, filter: { type: 'lowpass', freq: 900 }, at, peak: peak * 0.35, attack: 0.03,
    hold, decay });
}

// --- The sounds ---

// Each sound is sound(ctx, out, at, { distance }): it builds its nodes into `out` to start at `at` (context seconds)
// and returns when it ends. `distance` (world units from the window) dulls an explosion as it gets farther.
export const SOUNDS = Object.freeze({
  // A big console button: a bright tick of noise, a 1.2 kHz "tock" (spec §8) and a little low body.
  click(ctx, out, at) {
    const v = voice(ctx, out);
    v.noise({ type: 'bandpass', freq: 3800, at, peak: 0.15, attack: 0.0008, decay: 0.012 });
    v.tone({ freq: 1250, to: 1150, at, peak: 0.09, attack: 0.001, decay: 0.04 });
    v.tone({ freq: 170, at, peak: 0.06, attack: 0.002, decay: 0.035 });
    return v.end;
  },

  // A toggle, the lever, the dial: a 200 Hz square "clack" (spec §8) with a sharp snap of noise on it, and the smaller
  // tick of the switch settling 20 ms later.
  clack(ctx, out, at) {
    const v = voice(ctx, out);
    v.tone({ type: 'square', freq: 210, to: 170, glide: 0.03, filter: { type: 'lowpass', freq: 1800, q: 4 }, at,
      peak: 0.09, attack: 0.001, decay: 0.03 });
    v.noise({ type: 'highpass', freq: 2600, at, peak: 0.11, attack: 0.0005, decay: 0.008 });
    v.noise({ type: 'bandpass', freq: 3200, q: 1.5, at: at + 0.02, peak: 0.12, attack: 0.0005, decay: 0.006 });
    return v.end;
  },

  // An interceptor leaving the launcher: the booster's thump, then a band-passed rush of noise sweeping from 400 Hz to
  // 2 kHz (spec §8) as it climbs away, with the motor's hiss on top.
  launch(ctx, out, at) {
    const v = voice(ctx, out);
    v.noise({ freq: 900, to: 220, sweep: 0.25, q: 2, at, peak: 0.28, attack: 0.003, decay: 0.35 });
    v.tone({ freq: 130 * vary(0.05), to: 45, glide: 0.15, at, peak: 0.24, attack: 0.002, decay: 0.3 });
    v.noise({ type: 'bandpass', freq: 400, to: 2000, sweep: 0.6, q: 1.2, at, peak: 0.55, attack: 0.05, hold: 0.3,
      decay: 0.55 });
    v.noise({ type: 'highpass', freq: 2500, to: 5000, sweep: 0.8, at: at + 0.02, peak: 0.065, attack: 0.03,
      hold: 0.2, decay: 0.6 });
    return v.end;
  },

  // An interception in the sky: a sharp crack, a low-passed blast of noise with a thump falling to 60 Hz and below
  // (spec §8), and its echo off the hills. Farther away the crack and the blast are duller and the echo comes later.
  intercept(ctx, out, at, { distance } = {}) {
    const v = voice(ctx, out);
    const far = farness(distance);
    const air = 1 - 0.55 * far; // what is left of the highs
    v.noise({ type: 'highpass', freq: 1800, at, peak: 0.22 * air, attack: 0.0005, decay: 0.025 });
    v.noise({ freq: 3000 * air, to: 250, sweep: 0.35, at, peak: 0.48, attack: 0.002, decay: 0.55 });
    v.tone({ freq: 120 * vary(0.08), to: 50, glide: 0.12, at, peak: 0.32, attack: 0.005, decay: 0.35 });
    v.noise({ freq: 900 * air, to: 180, at: at + 0.18 + 0.12 * far, peak: 0.16, attack: 0.04, decay: 0.9 });
    return v.end;
  },

  // A rocket on a neighborhood: a crack, a deep low-passed blast with a thud falling to 40 Hz (spec §8), a long rumble
  // of brown noise and debris raining down for a second. Louder and longer than one on open ground.
  impactPopulated(ctx, out, at, { distance } = {}) {
    const v = voice(ctx, out);
    const air = 1 - 0.55 * farness(distance);
    v.noise({ type: 'highpass', freq: 1200, at, peak: 0.2 * air, attack: 0.0005, decay: 0.04 });
    v.tone({ freq: 110 * vary(0.08), to: 38, glide: 0.25, at, peak: 0.37, attack: 0.005, decay: 0.9 });
    v.noise({ freq: 2000 * air, to: 110, sweep: 0.8, q: 2, at, peak: 0.44, attack: 0.003, decay: 1.4 });
    v.noise({ color: 'brown', freq: 260, to: 80, sweep: 2, q: 3, at, peak: 0.37, attack: 0.1, hold: 0.25, decay: 2 });
    for (let i = 0; i < 6; i++) {
      v.noise({ type: 'bandpass', freq: 1800 + Math.random() * 2700, q: 2, at: at + 0.18 + Math.random() * 0.9,
        peak: (0.12 + Math.random() * 0.12) * air, attack: 0.0005, decay: 0.015 + Math.random() * 0.03 });
    }
    return v.end;
  },

  // A rocket on open ground: the same blast, smaller and shorter, and no debris.
  impactOpen(ctx, out, at, { distance } = {}) {
    const v = voice(ctx, out);
    const air = 1 - 0.55 * farness(distance);
    v.noise({ type: 'highpass', freq: 1000, at, peak: 0.18 * air, attack: 0.0005, decay: 0.03 });
    v.tone({ freq: 95 * vary(0.08), to: 40, glide: 0.2, at, peak: 0.32, attack: 0.003, decay: 0.7 });
    v.noise({ freq: 1300 * air, to: 140, sweep: 0.6, q: 2, at, peak: 0.38, attack: 0.003, decay: 1 });
    v.noise({ color: 'brown', freq: 220, to: 90, sweep: 1.2, q: 3, at, peak: 0.25, attack: 0.06, hold: 0.1,
      decay: 1.2 });
    return v.end;
  },

  // The alert siren (spec §8): two sawtooths a few cents apart, like two horns, switching between 800 and 600 Hz every
  // half second with a short slide, through a loudspeaker's band.
  siren(ctx, out, at) {
    const v = voice(ctx, out);
    const { high, low, step, slide, length, peak } = SIREN;
    const end = at + length;
    const level = v.gain(0);
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(peak, at + 0.06);
    level.gain.setValueAtTime(peak, end - 0.4);
    level.gain.linearRampToValueAtTime(0, end);
    const horn = v.line(v.filter('highpass', 350), v.filter('lowpass', 2800), level, out);
    for (const detune of [-7, 7]) {
      const osc = v.oscillator('sawtooth', high, at, end);
      osc.detune.value = detune;
      for (let k = 1; at + k * step < end; k++) {
        const t = at + k * step;
        osc.frequency.setValueAtTime(k % 2 ? high : low, t - slide);
        osc.frequency.linearRampToValueAtTime(k % 2 ? low : high, t);
      }
      osc.connect(horn);
    }
    return v.end;
  },

  // A life lost: a falling tone (spec §8), a square wave with a sob of vibrato sliding down two octaves over a
  // triangle an octave below it.
  lifeLost(ctx, out, at) {
    const v = voice(ctx, out);
    const shape = { at, attack: 0.01, hold: 0.4, decay: 0.5 };
    const osc = v.tone({ type: 'square', freq: 660, to: 165, glide: 0.9, filter: { type: 'lowpass', freq: 1600, q: 2 },
      peak: 0.08, ...shape });
    v.wobble(osc.detune, { rate: 7, depth: 35, at, end: v.end });
    v.tone({ type: 'triangle', freq: 330, to: 82.5, glide: 0.9, peak: 0.12, ...shape });
    return v.end;
  },

  // A new track on radar: a crisp 1.5 kHz blip (spec §8) with a glint an octave up, and its faint return.
  ping(ctx, out, at) {
    const v = voice(ctx, out);
    v.tone({ freq: 1500, at, peak: 0.15, attack: 0.002, decay: 0.09 });
    v.tone({ freq: 3000, at, peak: 0.03, attack: 0.001, decay: 0.03 });
    v.tone({ freq: 1500, at: at + 0.13, peak: 0.035, attack: 0.004, decay: 0.12 });
    return v.end;
  },

  // Low resources, or a jammed radar: two short 880 Hz beeps (spec §8), a square through a lowpass, a console alarm.
  warning(ctx, out, at) {
    const v = voice(ctx, out);
    for (const start of [at, at + 0.2]) {
      v.tone({ type: 'square', freq: 880, filter: { type: 'lowpass', freq: 2600 }, at: start, peak: 0.09,
        attack: 0.004, hold: 0.09, decay: 0.05 });
    }
    return v.end;
  },

  // A round starts: a bugle call up the C major chord, G4 C5 E5, then G5 held, on brass.
  roundStart(ctx, out, at) {
    const v = voice(ctx, out);
    for (const [i, freq] of [NOTE.G4, NOTE.C5, NOTE.E5].entries()) {
      brass(v, at + i * 0.09, freq, { peak: 0.13, hold: 0.04, decay: 0.15 });
    }
    brass(v, at + 0.27, NOTE.G5, { peak: 0.13, hold: 0.2, decay: 0.45 });
    return v.end;
  },

  // A round ends: a calm climb, E5 G5 C6 on soft mallets, the last left to ring, over a held C major chord.
  roundEnd(ctx, out, at) {
    const v = voice(ctx, out);
    for (const freq of [NOTE.C4, NOTE.E4, NOTE.G4]) {
      v.tone({ freq, at, peak: 0.035, attack: 0.15, hold: 0.4, decay: 1.2 });
    }
    for (const [i, freq] of [NOTE.E5, NOTE.G5, NOTE.C6].entries()) {
      mallet(v, at + i * 0.14, freq, { peak: 0.1, decay: i < 2 ? 0.7 : 1.3 });
    }
    return v.end;
  },

  // The campaign won: a brass fanfare, the call up the chord (G4 C5 E5), then a held C major chord with a bell on top.
  victory(ctx, out, at) {
    const v = voice(ctx, out);
    for (const [i, freq] of [NOTE.G4, NOTE.C5, NOTE.E5].entries()) {
      brass(v, at + i * 0.13, freq, { peak: 0.12, hold: 0.05, decay: 0.2 });
    }
    const chord = at + 0.39;
    for (const freq of [NOTE.C4, NOTE.G4, NOTE.C5, NOTE.E5, NOTE.G5]) {
      brass(v, chord, freq, { peak: 0.06, hold: 0.9, decay: 0.8 });
    }
    bell(v, chord, NOTE.C6, { peak: 0.06, decay: 1.6 });
    return v.end;
  },

  // Game over: a slow fall down the A minor chord (E5 C5 A4) to a low A minor chord that sags as it fades.
  gameOver(ctx, out, at) {
    const v = voice(ctx, out);
    for (const [i, freq] of [NOTE.E5, NOTE.C5, NOTE.A4].entries()) {
      sombre(v, at + i * 0.3, freq, { peak: 0.12, decay: 0.55 });
    }
    for (const freq of [NOTE.A2, NOTE.A3, NOTE.C4, NOTE.E4]) {
      sombre(v, at + 0.9, freq, { peak: 0.05, hold: 0.5, decay: 1.6 });
    }
    return v.end;
  },

  // A mission done: a chime up G5 C6 E6 on struck bars, the last left to ring.
  mission(ctx, out, at) {
    const v = voice(ctx, out);
    for (const [i, freq] of [NOTE.G5, NOTE.C6, NOTE.E6].entries()) {
      bell(v, at + i * 0.09, freq, { peak: 0.09, decay: i < 2 ? 0.7 : 1.2 });
    }
    return v.end;
  },

  // HQ's line: two rings of an old desk phone (spec §8), its two bells struck many times a second by the clapper.
  phone(ctx, out, at) {
    const v = voice(ctx, out);
    const { rings, length, gap, strikes, bells, peak } = RING;
    const end = at + rings * (length + gap);
    const level = v.gain(0);
    for (let i = 0; i < rings; i++) {
      const t = at + i * (length + gap);
      level.gain.setValueAtTime(0, t);
      level.gain.linearRampToValueAtTime(peak, t + 0.005);
      level.gain.setValueAtTime(peak, t + length - 0.03);
      level.gain.linearRampToValueAtTime(0, t + length);
    }
    // The clapper: a gain that a falling sawtooth knocks up to 1 and lets fall back to 0 at every strike.
    const clapper = v.gain(0.5);
    v.line(v.oscillator('sawtooth', strikes, at, end), v.gain(-0.5), clapper.gain);
    v.line(clapper, level, out);
    for (const [freq, share] of bells) v.line(v.oscillator('sine', freq, at, end), v.gain(share), clapper);
    return v.end;
  },

  // A refusal, or a miss: a short low buzzer, two square waves 6 Hz apart that beat, through a lowpass.
  buzz(ctx, out, at) {
    const v = voice(ctx, out);
    for (const freq of [110, 116]) {
      v.tone({ type: 'square', freq, filter: { type: 'lowpass', freq: 1400 }, at, peak: 0.055, attack: 0.005,
        hold: 0.16, decay: 0.06 });
    }
    return v.end;
  },
});

// The room's hum (spec §8), from `at` into `out`, fading in: brown noise through a low lowpass, the 50 Hz mains with
// two harmonics, and the air from the vents, which swells and ebbs. Returns stop(when), which fades it out from `when`
// and stops it.
export function startHum(ctx, out, at) {
  const v = voice(ctx, out);
  const fade = v.gain(0);
  fade.gain.setValueAtTime(0, at);
  fade.gain.linearRampToValueAtTime(1, at + HUM.fadeIn);
  fade.connect(out);
  v.line(v.noiseSource('brown', at), v.filter('lowpass', 160, { q: -3 }), v.gain(HUM.room), fade);
  for (const [freq, level] of HUM.mains) v.line(v.oscillator('sine', freq, at), v.gain(level), fade);
  const air = v.gain(HUM.air);
  v.line(v.noiseSource('white', at), v.filter('bandpass', 700, { q: 0.5 }), air, fade);
  v.wobble(air.gain, { rate: 0.07, depth: HUM.air * 0.5, at });
  return when => {
    fade.gain.cancelScheduledValues(when);
    fade.gain.setValueAtTime(fade.gain.value, when);
    fade.gain.linearRampToValueAtTime(0, when + HUM.fadeOut);
    v.stop(when + HUM.fadeOut);
  };
}

// createAudio(settings, { onMutedChange }) returns:
//   unlock()           creates the audio context at its first call (later ones resume it if it is suspended), builds
//                      the mix and starts the hum; a Promise of whether the context is running. Call it on a gesture.
//   play(name, opts)   plays a sound of SOUNDS. opts.gain scales it (1 unless given); opts.distance, in world units
//                      from the window, makes it fainter (see FALLOFF) and duller. True when it plays, or when the
//                      same sound played less than its MIN_INTERVAL ago and stands for this one; false before unlock(),
//                      while the context is not running (unless unlock() is starting it), while muted, and for an
//                      unknown name, which also warns once on the console. It never throws: the game plays on without
//                      a sound that fails.
//   setVolume(v)       sets the volume, 0..1; setMuted(m) the mute. Both write `settings` (the game's settings object,
//                      shared with the settings screen) and take effect at once.
//   toggleMuted()      flips the mute, then calls onMutedChange(muted) (main.js saves the settings); returns whether
//                      the sound is now muted.
//   startAmbience(), stopAmbience()   start (once unlocked) and stop the room's hum.
//   bind(bus, session, { listener })  plays the sounds of the session's events, explosions heard from `listener`
//                      (the window's centre, in the session's coordinates).
//   ready              whether the context is running.
export function createAudio(settings = { volume: 1, muted: false }, { onMutedChange = () => {} } = {}) {
  let ctx = null; // the AudioContext, from the first unlock()
  let input = null; // where the sounds go: the compressor
  let master = null; // the master gain, after the compressor
  let stopHum = null; // stops the hum while it plays
  // A context may start a moment after it is made (the spec has it so; Chrome starts it at once). While unlock() waits
  // for that, a sound is scheduled all the same and plays as the context starts: the first round's jingle among them.
  let starting = false;
  const lastPlayed = new Map(); // name → when it last started, in context seconds (for MIN_INTERVAL)
  const playing = new Map(); // name → { out, end } of the last SINGLE sound of that name
  const warned = new Set();

  const level = () => (settings.muted ? 0 : clamp(Number(settings.volume) || 0, 0, 1));

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message);
  }

  // The context and the mix: the compressor, its trim, the master gain.
  function build() {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) return false;
    ctx = new Context();
    master = ctx.createGain();
    master.gain.value = level();
    master.connect(ctx.destination);
    const trim = ctx.createGain();
    trim.gain.value = TRIM;
    trim.connect(master);
    input = ctx.createDynamicsCompressor();
    for (const [name, value] of Object.entries(COMPRESSOR)) input[name].value = value;
    input.connect(trim);
    return true;
  }

  async function unlock() {
    try {
      if (!ctx && !build()) return false;
      startAmbience();
      if (ctx.state !== 'running') {
        // A context not allowed to start yet leaves resume() pending until a gesture: wait a while, not for ever.
        starting = true;
        const resumed = ctx.resume().catch(() => {});
        await Promise.race([resumed, new Promise(resolve => setTimeout(resolve, RESUME_WAIT))]);
      }
      return ctx.state === 'running';
    } catch (error) {
      warnOnce('unlock', `audio: could not start (${error?.message ?? error})`);
      return false;
    } finally {
      starting = false;
    }
  }

  // Whether a sound can be scheduled: the context is running, or unlock() is starting it.
  const live = () => ctx !== null && (ctx.state === 'running' || (starting && ctx.state === 'suspended'));

  function play(name, opts) {
    if (!Object.hasOwn(SOUNDS, name)) {
      warnOnce(`name:${name}`, `audio: there is no sound "${name}"`);
      return false;
    }
    if (!live() || settings.muted) return false;
    const now = ctx.currentTime;
    if (now - (lastPlayed.get(name) ?? -Infinity) < (MIN_INTERVAL[name] ?? 0)) return true;
    const { gain = 1, distance } = opts ?? {};
    try {
      const out = ctx.createGain();
      out.gain.value = Math.max(0, Number(gain) || 0) * falloff(distance);
      out.connect(input);
      ownOutputs.add(out);
      const end = SOUNDS[name](ctx, out, now + LEAD, { distance });
      lastPlayed.set(name, now);
      if (SINGLE.has(name)) {
        const before = playing.get(name);
        if (before && before.end > now) before.out.gain.setTargetAtTime(0, now, CUT);
        playing.set(name, { out, end });
      }
      return true;
    } catch (error) {
      warnOnce(`failed:${name}`, `audio: "${name}" could not play (${error?.message ?? error})`);
      return false;
    }
  }

  function applyLevel() {
    if (master) master.gain.setTargetAtTime(level(), ctx.currentTime, VOLUME_GLIDE);
  }

  function setVolume(volume) {
    settings.volume = clamp(Number(volume) || 0, 0, 1);
    applyLevel();
  }

  function setMuted(muted) {
    settings.muted = Boolean(muted);
    applyLevel();
  }

  function toggleMuted() {
    setMuted(!settings.muted);
    onMutedChange(settings.muted);
    return settings.muted;
  }

  function startAmbience() {
    if (!ctx || stopHum) return;
    stopHum = startHum(ctx, input, ctx.currentTime + LEAD);
  }

  function stopAmbience() {
    if (!stopHum) return;
    stopHum(ctx.currentTime);
    stopHum = null;
  }

  // The session's events and their sounds (spec §8). Explosions and misses are heard from `listener`: the farther,
  // the fainter. Two jingles give way to the one that follows them in the same frame: no life-lost tone on the last
  // life (game over follows), and no round-end one when the round ends the campaign (victory follows).
  function bind(bus, session, { listener = null } = {}) {
    const distanceTo = position => (listener && position
      ? Math.hypot(position.x - listener.x, position.y - listener.y, position.z - listener.z)
      : undefined);
    const reactions = {
      'interceptor:launched': () => play('launch'),
      'threat:intercepted': ({ position }) => play('intercept', { distance: distanceTo(position) }),
      'threat:damaged': ({ position, threat }) => play('intercept', {
        gain: 0.5, distance: distanceTo(position ?? threat?.position),
      }),
      'threat:impact': ({ populated, decoy, position }) => {
        const distance = distanceTo(position);
        if (decoy) play('impactOpen', { gain: 0.3, distance });
        else play(populated ? 'impactPopulated' : 'impactOpen', { distance });
      },
      'interceptor:missed': ({ position }) => play('buzz', { gain: 0.4, distance: distanceTo(position) }),
      'threat:detected': () => play('ping'),
      'alert:sounded': () => play('siren'), // in time or not, the siren sounds (spec §6)
      'life:lost': ({ lives }) => {
        if (lives > 0) play('lifeLost');
      },
      'engage:refused': () => play('buzz'),
      'round:start': () => play('roundStart'),
      'round:end': () => {
        if (session.state.phase !== 'victory') play('roundEnd');
      },
      'campaign:victory': () => play('victory'),
      'game:over': () => play('gameOver'),
      'mission:complete': () => play('mission'),
      'hq:line': () => play('phone'),
      'hazard:jamming': ({ on }) => {
        if (on) play('warning');
      },
    };
    for (const [type, react] of Object.entries(reactions)) bus.on(type, react);
  }

  return {
    unlock, play, setVolume, setMuted, toggleMuted, startAmbience, stopAmbience, bind,
    get ready() {
      return ctx?.state === 'running';
    },
  };
}
