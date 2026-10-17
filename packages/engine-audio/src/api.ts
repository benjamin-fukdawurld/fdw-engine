import type { IVec3 } from '@fdw/engine-backend';

/**
 * Decoded samples, in the memory of the audio engine: a short sound (a
 * shot, a step, a click), played often, by many voices at once.
 */
export interface AudioClip {
  readonly kind: 'clip';
  /** In seconds. */
  readonly duration: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** The samples per channel. */
  readonly frames: number;
  /** The memory held by the samples. */
  readonly byteLength: number;
  readonly disposed: boolean;
  /**
   * Frees the samples once the voices playing them are done. The clip
   * cannot be played any more.
   */
  dispose(): void;
}

/**
 * The bytes of a file kept encoded, decoded by each voice while it plays:
 * a music, a long ambience. A few hundred kilobytes in place of tens of
 * megabytes of samples; a little more work while playing.
 */
export interface AudioStream {
  readonly kind: 'stream';
  /** In seconds; NaN when the file does not tell it. */
  readonly duration: number;
  /** The memory held by the encoded bytes. */
  readonly byteLength: number;
  readonly disposed: boolean;
  /** Frees the bytes once the voices playing them are done. */
  dispose(): void;
}

/** What a voice plays. */
export type AudioSource = AudioClip | AudioStream;

/**
 * How the volume of a spatial voice falls with its distance `d` to the
 * listener, `r` its `refDistance`, `f` its `rolloff`, `m` its `maxDistance`
 * (those of WebAudio):
 * - `inverse`: `r / (r + f (max(d, r) - r))`, the physical one;
 * - `linear`: `1 - f (clamp(d, r, m) - r) / (m - r)`, silent at `m`;
 * - `exponential`: `(max(d, r) / r)^-f`.
 */
export type DistanceModel = 'inverse' | 'linear' | 'exponential';

/** A voice placed in the world, heard from the listener. */
export interface SpatialOptions {
  /** Default the origin; then `voice.setPosition`. */
  readonly position?: Partial<IVec3>;
  /** The distance at which the attenuation starts. Default 1. */
  readonly refDistance?: number;
  /** Where the linear model falls silent. Default 100. */
  readonly maxDistance?: number;
  /** How fast the volume falls. Default 1. */
  readonly rolloff?: number;
  /** Default `inverse`. */
  readonly distanceModel?: DistanceModel;
}

export interface PlayOptions {
  /** Where the voice is mixed. Default the master bus. */
  readonly bus?: AudioBus;
  /** A linear gain. Default 1. */
  readonly volume?: number;
  /** The playback rate: 2 is an octave up and twice faster. Default 1. */
  readonly pitch?: number;
  /** From -1 (left) to 1 (right), for a voice that is not spatial. Default 0. */
  readonly pan?: number;
  /** Plays again from the start at the end. Default false. */
  readonly loop?: boolean;
  /** Starts at, in seconds. Default 0. */
  readonly offset?: number;
  /** Rises from silence in, seconds. Default 0: at once. */
  readonly fadeIn?: number;
  /** Created paused: `resume()` starts it. Default false. */
  readonly paused?: boolean;
  /** Places the voice in the world. Default: not spatial, `pan` instead. */
  readonly spatial?: SpatialOptions;
}

/**
 * - `playing`: heard, or about to be (an engine suspended until a gesture);
 * - `paused`: kept where it is, `resume()` goes on;
 * - `stopped`: at its end, or stopped: it is gone.
 */
export type VoiceState = 'playing' | 'paused' | 'stopped';

/** A source playing: one at a time per call to `play`. */
export interface Voice {
  readonly source: AudioSource;
  readonly bus: AudioBus;
  readonly spatial: boolean;
  readonly state: VoiceState;
  /** Where it is in its source, in seconds. */
  readonly time: number;
  /** Resolved when the voice stops: at its end, or by `stop`. */
  readonly ended: Promise<void>;
  /** A linear gain, multiplied by the one of the fades. */
  volume: number;
  pitch: number;
  pan: number;
  loop: boolean;
  /** For a spatial voice: its position in the world. */
  setPosition(x: number, y: number, z: number): void;
  /** Takes the gain of the fades to `gain` in `seconds` (1: unchanged). */
  fadeTo(gain: number, seconds: number): void;
  pause(): void;
  resume(): void;
  /** Fades out in `fadeOut` seconds (default 0: at once), then stops. */
  stop(fadeOut?: number): void;
}

/**
 * A mixing bus: the voices and the buses under it, mixed at a volume. The
 * master bus is the output; a game has its `sfx`, `music`, `voice` buses
 * under it, each with its slider.
 */
export interface AudioBus {
  readonly name: string;
  /** Undefined for the master bus. */
  readonly parent: AudioBus | undefined;
  /** A linear gain. */
  volume: number;
  muted: boolean;
  /** Stops the voices of this bus and of the buses under it. */
  stopAll(fadeOut?: number): void;
}

/** Where the sound is heard from: the camera, the player. */
export interface AudioListener {
  readonly position: Readonly<IVec3>;
  readonly forward: Readonly<IVec3>;
  readonly up: Readonly<IVec3>;
  /** `forward` and `up` need not be normalized. */
  setPose(position: IVec3, forward: IVec3, up: IVec3): void;
  /**
   * The pose of a world matrix (column major), looking along -z: the one of
   * the node of a camera.
   */
  setMatrix(matrix: ArrayLike<number>): void;
}

/** `running`, or `suspended` (a page before a gesture), or `closed` (destroyed). */
export type AudioEngineState = 'running' | 'suspended' | 'closed';

export interface DecodeOptions {
  readonly signal?: AbortSignal;
}

export interface CreateBusOptions {
  /** Default the master bus. */
  readonly parent?: AudioBus;
  /** Default 1. */
  readonly volume?: number;
}

/**
 * An audio engine: decodes, mixes and plays the sounds. Implemented by
 * `WebAudioEngine` (`@fdw/engine-audio-web`) in a page, `NativeAudioEngine`
 * (`@fdw/engine-audio-native`, miniaudio) in Node, `FakeAudioEngine` in
 * the tests; another one only changes its creation.
 */
export interface AudioEngine {
  readonly name: string;
  readonly state: AudioEngineState;
  readonly sampleRate: number;
  /** The clock of the mix, in seconds. */
  readonly time: number;
  readonly master: AudioBus;
  readonly listener: AudioListener;
  /** The voices alive: playing, paused or fading out. */
  readonly voices: readonly Voice[];

  /** A bus, under the master unless told. The names are unique. */
  createBus(name: string, options?: CreateBusOptions): AudioBus;
  /** A bus by its name; `master` is the master bus. */
  bus(name: string): AudioBus | undefined;

  /** A clip from samples, one array per channel: a sound made by code. */
  createClip(channels: readonly Float32Array[], sampleRate: number): AudioClip;
  /** Decodes a WAV, Ogg Vorbis, MP3 or FLAC file (by its bytes, not copied). */
  decodeClip(bytes: Uint8Array, options?: DecodeOptions): Promise<AudioClip>;
  /** Keeps the bytes of a WAV, Ogg Vorbis, MP3 or FLAC file, to stream them. */
  createStream(
    bytes: Uint8Array,
    options?: DecodeOptions,
  ): Promise<AudioStream>;

  play(source: AudioSource, options?: PlayOptions): Voice;

  /**
   * Starts the output. In a page, the browser lets it start only after a
   * gesture (a click, a key): call it from one.
   */
  resume(): Promise<void>;
  suspend(): Promise<void>;
  /** To call at each frame: the voices that ended are freed and resolved. */
  update(): void;
  /** Stops the voices, frees the engine. */
  destroy(): void;
}

/** The options of `play`, with their defaults. */
export interface ResolvedPlay {
  readonly volume: number;
  readonly pitch: number;
  readonly pan: number;
  readonly loop: boolean;
  readonly offset: number;
  readonly fadeIn: number;
  readonly paused: boolean;
  readonly spatial: Required<Omit<SpatialOptions, 'position'>> & {
    readonly position: IVec3;
  };
  readonly isSpatial: boolean;
}

/** The defaults of `PlayOptions`, for the engines. */
export function resolvePlay(options: PlayOptions = {}): ResolvedPlay {
  const spatial = options.spatial ?? {};
  return {
    volume: options.volume ?? 1,
    pitch: options.pitch ?? 1,
    pan: options.pan ?? 0,
    loop: options.loop ?? false,
    offset: options.offset ?? 0,
    fadeIn: options.fadeIn ?? 0,
    paused: options.paused ?? false,
    spatial: {
      position: {
        x: spatial.position?.x ?? 0,
        y: spatial.position?.y ?? 0,
        z: spatial.position?.z ?? 0,
      },
      refDistance: spatial.refDistance ?? 1,
      maxDistance: spatial.maxDistance ?? 100,
      rolloff: spatial.rolloff ?? 1,
      distanceModel: spatial.distanceModel ?? 'inverse',
    },
    isSpatial: options.spatial !== undefined,
  };
}

/** Whether `bus` is `ancestor` or under it. */
export function isUnder(bus: AudioBus, ancestor: AudioBus): boolean {
  for (let b: AudioBus | undefined = bus; b; b = b.parent) {
    if (b === ancestor) {
      return true;
    }
  }
  return false;
}

/**
 * The pose of the listener in a world matrix (column major): the
 * translation, -z, y.
 */
export function poseOfMatrix(
  m: ArrayLike<number>,
): [position: IVec3, forward: IVec3, up: IVec3] {
  return [
    { x: m[12], y: m[13], z: m[14] },
    { x: -m[8], y: -m[9], z: -m[10] },
    { x: m[4], y: m[5], z: m[6] },
  ];
}

/** Normalizes a direction; a null one becomes `fallback`. */
export function normalize(v: IVec3, fallback: IVec3): IVec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  return length > 1e-9
    ? { x: v.x / length, y: v.y / length, z: v.z / length }
    : { ...fallback };
}
