// Sounds made by code for the demos: no file to load, the same in the
// browser and in the native demos. Each function returns the samples of
// one channel, from -1 to 1. Without imports: tools/audio/generate.mjs
// runs it in Node to write the sound files of the documentation.

/** A random generator from a seed: the same sounds at every run. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** `seconds` of samples, each given by `sample(t)`, t in seconds. */
export function synth(
  seconds: number,
  rate: number,
  sample: (t: number) => number,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    out[i] = sample(i / rate);
  }
  return out;
}

const tau = 2 * Math.PI;

/** A note: its frequency from its number, 69 the A of 440 Hz. */
export const frequency = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** A gunshot: a burst of noise and a falling thump. */
export function shotSound(rate: number): Float32Array<ArrayBuffer> {
  const random = seeded(7);
  let low = 0;
  let phase = 0;
  return synth(0.35, rate, (t) => {
    // Noise, darker as it fades.
    const noise = random() * 2 - 1;
    low += (noise - low) * Math.max(0.08, 0.9 - t * 4);
    phase += (tau * (140 * Math.exp(-t * 18) + 45)) / rate;
    return (
      0.7 * low * Math.exp(-t * 14) + 0.6 * Math.sin(phase) * Math.exp(-t * 10)
    );
  });
}

/** A metallic tick: a shot that hit. */
export function hitSound(rate: number): Float32Array<ArrayBuffer> {
  return synth(0.12, rate, (t) => {
    const env = Math.exp(-t * 45);
    return (
      0.5 * env * Math.sin(tau * 1760 * t) +
      0.3 * env * Math.sin(tau * 2637 * t)
    );
  });
}

/** An explosion: a long rumble of dark noise. */
export function explosionSound(rate: number): Float32Array<ArrayBuffer> {
  const random = seeded(11);
  let low = 0;
  let lower = 0;
  let phase = 0;
  return synth(1.2, rate, (t) => {
    low += (random() * 2 - 1 - low) * 0.12;
    lower += (low - lower) * 0.2;
    phase += (tau * (70 * Math.exp(-t * 3) + 30)) / rate;
    const attack = Math.min(1, t * 200);
    return (
      attack *
      (1.6 * lower * Math.exp(-t * 3) +
        0.5 * Math.sin(phase) * Math.exp(-t * 5))
    );
  });
}

/** A low blow: the player hurt. */
export function hurtSound(rate: number): Float32Array<ArrayBuffer> {
  return synth(0.4, rate, (t) => {
    const f = 110 * Math.exp(-t * 2);
    // A soft square: its odd harmonics.
    const x = tau * f * t;
    const square = Math.sin(x) + Math.sin(3 * x) / 3 + Math.sin(5 * x) / 5;
    return 0.45 * square * Math.exp(-t * 8);
  });
}

/** Two rising notes: a wave comes, a menu entry chosen. */
export function chimeSound(
  rate: number,
  notes = [76, 83],
): Float32Array<ArrayBuffer> {
  const gap = 0.12;
  return synth(gap * notes.length + 0.5, rate, (t) => {
    let s = 0;
    notes.forEach((note, i) => {
      const local = t - i * gap;
      if (local >= 0) {
        const f = frequency(note);
        s +=
          Math.exp(-local * 6) *
          (Math.sin(tau * f * local) + 0.3 * Math.sin(tau * 2 * f * local));
      }
    });
    return 0.3 * s;
  });
}

/**
 * The hum of a drone, one second that loops without a seam: whole cycles
 * of every frequency in it.
 */
export function humSound(rate: number): Float32Array<ArrayBuffer> {
  return synth(1, rate, (t) => {
    const tremolo = 0.75 + 0.25 * Math.sin(tau * 6 * t);
    return (
      tremolo *
      (0.35 * Math.sin(tau * 95 * t) +
        0.2 * Math.sin(tau * 190 * t + 1) +
        0.1 * Math.sin(tau * 285 * t + 2) +
        0.05 * Math.sin(tau * 1140 * t))
    );
  });
}

export interface MusicOptions {
  /** The beats per minute. Default 100. */
  readonly tempo?: number;
  /** The root notes of the bars, one per bar. */
  readonly roots?: readonly number[];
  /** The intervals of the chord over each root. Default a minor triad. */
  readonly chord?: readonly number[];
  /** The arpeggio: the steps in the chord, one per eighth. */
  readonly arpeggio?: readonly number[];
}

/**
 * A loop of music, four beats per bar, `bars` bars: a bass on the roots, a
 * soft pad of the chords, an arpeggio over them. Each note ends within its
 * bar: the end meets the start.
 */
export function musicLoop(
  rate: number,
  options: MusicOptions = {},
): Float32Array<ArrayBuffer> {
  const tempo = options.tempo ?? 100;
  const roots = options.roots ?? [45, 41, 48, 43];
  const chord = options.chord ?? [0, 3, 7];
  const arpeggio = options.arpeggio ?? [0, 1, 2, 3, 2, 1, 0, 2];
  const beat = 60 / tempo;
  const bar = 4 * beat;
  const out = new Float32Array(Math.round(roots.length * bar * rate));
  const add = (
    start: number,
    length: number,
    note: number,
    gain: number,
    voice: (phase: number) => number,
    attack: number,
  ) => {
    const f = frequency(note);
    const from = Math.round(start * rate);
    const count = Math.min(Math.round(length * rate), out.length - from);
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      const env =
        Math.min(1, t / attack) * Math.min(1, (length - t) / 0.05) * gain;
      out[from + i] += env * voice(tau * f * t);
    }
  };
  const sine = Math.sin;
  const soft = (x: number) => Math.sin(x) + 0.25 * Math.sin(2 * x);
  roots.forEach((root, b) => {
    const start = b * bar;
    // The bass: the root on the beats 1 and 3.
    add(start, 2 * beat, root - 12, 0.3, soft, 0.01);
    add(start + 2 * beat, 2 * beat, root - 12, 0.25, soft, 0.01);
    // The pad: the chord over the whole bar.
    for (const step of chord) {
      add(start, bar, root + 12 + step, 0.06, sine, 0.4);
    }
    // The arpeggio, in eighths.
    arpeggio.forEach((index, k) => {
      const octave = Math.floor(index / chord.length);
      const note = root + 24 + chord[index % chord.length] + 12 * octave;
      add(start + (k * beat) / 2, beat / 2, note, 0.09, soft, 0.005);
    });
  });
  // A gentle limit.
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.tanh(out[i] * 1.2) / 1.2;
  }
  return out;
}

// Noise filtered by a one-pole low pass, its cut given at each sample
// (0 to 1: the share of the new sample kept).
function lowPassNoise(random: () => number) {
  let low = 0;
  return (cut: number) => {
    low += (random() * 2 - 1 - low) * cut;
    return low;
  };
}

/** A step on soft ground: a muffled thud and the crunch of leaves. */
export function footstepSound(
  rate: number,
  seed = 3,
): Float32Array<ArrayBuffer> {
  const random = seeded(seed);
  const thud = lowPassNoise(random);
  const crunch = lowPassNoise(seeded(seed + 1));
  return synth(0.18, rate, (t) => {
    const attack = Math.min(1, t * 400);
    return (
      attack *
      (1.4 * thud(0.05) * Math.exp(-t * 30) +
        0.25 * crunch(0.6) * Math.exp(-t * 45) * (random() < 0.6 ? 1 : 0.3))
    );
  });
}

/** A blade cutting the air: noise rising then falling in pitch and loudness. */
export function swingSound(
  rate: number,
  length = 0.32,
): Float32Array<ArrayBuffer> {
  const random = seeded(17);
  let band = 0;
  let low = 0;
  return synth(length, rate, (t) => {
    const x = t / length;
    // Loudest at a third of the way: the blade fastest.
    const env = Math.sin(Math.PI * Math.min(1, x)) ** 2 * Math.exp(-x * 1.5);
    const cut = 0.05 + 0.35 * Math.sin(Math.PI * x);
    const noise = random() * 2 - 1;
    low += (noise - low) * cut;
    band += (low - band) * 0.5;
    return 0.9 * (low - band) * env * 2.5;
  });
}

/** A blade striking flesh: a heavy thud and a short tear. */
export function slashSound(rate: number): Float32Array<ArrayBuffer> {
  const random = seeded(23);
  const tear = lowPassNoise(random);
  let phase = 0;
  return synth(0.35, rate, (t) => {
    phase += (tau * (90 * Math.exp(-t * 12) + 40)) / rate;
    return (
      0.8 * Math.sin(phase) * Math.exp(-t * 14) +
      0.6 * tear(0.35) * Math.exp(-t * 22)
    );
  });
}

/** Steel on steel: a parry. Inharmonic partials, ringing. */
export function clangSound(rate: number): Float32Array<ArrayBuffer> {
  const random = seeded(29);
  const partials = [523, 1187, 1903, 2731, 3610];
  return synth(0.8, rate, (t) => {
    let s = 0;
    partials.forEach((f, i) => {
      s += (Math.sin(tau * f * t + i) * Math.exp(-t * (6 + i * 3))) / (i + 1);
    });
    const click = (random() * 2 - 1) * Math.exp(-t * 200);
    return 0.45 * s + 0.4 * click;
  });
}

/**
 * A grunt: a low buzzing voice through two formants of a vowel, pitched
 * by `pitch` (1 an orc, lower a demon), `length` seconds.
 */
export function gruntSound(
  rate: number,
  pitch = 1,
  length = 0.45,
  seed = 31,
): Float32Array<ArrayBuffer> {
  const random = seeded(seed);
  let phase = 0;
  // Two resonators (formants of "o"), each a two-pole filter.
  const formant = (f: number, q: number) => {
    const r = Math.exp((-Math.PI * f) / (q * rate));
    const c = 2 * r * Math.cos((tau * f) / rate);
    let y1 = 0;
    let y2 = 0;
    return (x: number) => {
      const y = x + c * y1 - r * r * y2;
      y2 = y1;
      y1 = y;
      return y * (1 - r);
    };
  };
  const first = formant(450 * pitch, 6);
  const second = formant(800 * pitch, 8);
  return synth(length, rate, (t) => {
    const x = t / length;
    const f0 =
      95 *
      pitch *
      (1 + 0.15 * Math.sin(Math.PI * x)) *
      (1 + 0.02 * (random() - 0.5));
    phase += f0 / rate;
    // A buzz: a sawtooth, rough with noise.
    const source = 2 * (phase % 1) - 1 + 0.3 * (random() * 2 - 1);
    const env = Math.min(1, x * 12) * Math.min(1, (1 - x) * 4);
    return Math.tanh(3 * (first(source) + 0.6 * second(source)) * env) * 0.6;
  });
}

/**
 * The forest, a loop of `seconds` without a seam: wind in the trees (dark
 * noise swelling slowly, whole cycles in the loop) and birds now and then.
 */
export function forestAmbience(
  rate: number,
  seconds = 12,
): Float32Array<ArrayBuffer> {
  const random = seeded(37);
  const wind = lowPassNoise(seeded(41));
  const out = synth(seconds, rate, (t) => {
    const swell =
      0.55 +
      0.3 * Math.sin((tau * 2 * t) / seconds) +
      0.15 * Math.sin((tau * 5 * t) / seconds + 1);
    return 0.5 * wind(0.02 + 0.03 * swell) * swell;
  });
  // The birds: short chirps, rising then falling, at random times.
  for (let n = 0; n < 9; n++) {
    const start = random() * (seconds - 1);
    const base = 2600 + random() * 1800;
    const chirps = 2 + Math.floor(random() * 4);
    for (let c = 0; c < chirps; c++) {
      const at = Math.round((start + c * 0.13) * rate);
      const length = Math.round(0.08 * rate);
      let phase = 0;
      for (let i = 0; i < length && at + i < out.length; i++) {
        const x = i / length;
        phase += (tau * base * (1 + 0.35 * Math.sin(Math.PI * x))) / rate;
        out[at + i] += 0.06 * Math.sin(phase) * Math.sin(Math.PI * x) ** 2;
      }
    }
  }
  // The end fades into the start: the wind has no seam.
  const blend = Math.round(0.5 * rate);
  for (let i = 0; i < blend; i++) {
    const w = i / blend;
    out[i] = out[i] * w + out[out.length - blend + i] * (1 - w);
  }
  return out.subarray(0, out.length - blend).slice();
}
