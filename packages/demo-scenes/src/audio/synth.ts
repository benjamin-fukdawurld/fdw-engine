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
