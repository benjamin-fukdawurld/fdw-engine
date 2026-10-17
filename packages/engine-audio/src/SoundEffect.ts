import type { IVec3 } from '@fdw/engine-backend';
import type {
  AudioEngine,
  AudioSource,
  PlayOptions,
  SpatialOptions,
  Voice,
} from './api';

export interface SoundEffectOptions extends Omit<
  PlayOptions,
  'loop' | 'paused' | 'offset'
> {
  /**
   * The volume drawn in `volume × (1 ± volumeVariation)` at each play.
   * Default 0.
   */
  readonly volumeVariation?: number;
  /**
   * The pitch drawn in `pitch × (1 ± pitchVariation)` at each play: the
   * same shot never sounds twice the same. Default 0.
   */
  readonly pitchVariation?: number;
  /**
   * The voices of the effect at most: past them, the oldest one stops.
   * Default 8.
   */
  readonly maxVoices?: number;
  /** The seconds between two plays; a play sooner is dropped. Default 0. */
  readonly cooldown?: number;
  /** The fade out of a voice stopped for a newer one, in seconds. Default 0.02. */
  readonly stealFade?: number;
  /** From 0 to 1. Default `Math.random`. */
  readonly random?: () => number;
}

/**
 * A short sound effect, played often: variations of a sound (one drawn at
 * each play, never the same twice in a row when there are several), a
 * volume and a pitch varied at random, a number of voices bounded (the
 * oldest stops for the newest), a cooldown.
 *
 * ```ts
 * const shot = new SoundEffect(engine, [shot1, shot2, shot3], {
 *   bus: sfx,
 *   pitchVariation: 0.08,
 *   maxVoices: 4,
 * });
 * shot.play();
 * shot.playAt(drone.worldPosition); // spatial
 * ```
 */
export class SoundEffect {
  readonly sources: readonly AudioSource[];
  readonly options: SoundEffectOptions;
  private readonly _voices: Voice[] = [];
  private _last = -1;
  private _playedAt = -Infinity;

  constructor(
    readonly engine: AudioEngine,
    sources: AudioSource | readonly AudioSource[],
    options: SoundEffectOptions = {},
  ) {
    this.sources = Array.isArray(sources)
      ? (sources as readonly AudioSource[])
      : [sources as AudioSource];
    if (this.sources.length === 0) {
      throw new Error('A sound effect needs a sound');
    }
    this.options = options;
  }

  /** The voices of the effect still playing. */
  get voices(): readonly Voice[] {
    this.prune();
    return this._voices;
  }

  /**
   * Plays a variation, the options of the effect overridden by `options`.
   * Undefined within the cooldown.
   */
  play(options: SoundEffectOptions = {}): Voice | undefined {
    const o = { ...this.options, ...options };
    const time = this.engine.time;
    if (time - this._playedAt < (o.cooldown ?? 0)) {
      return undefined;
    }
    this.prune();
    const max = Math.max(1, o.maxVoices ?? 8);
    while (this._voices.length >= max) {
      this._voices.shift()?.stop(o.stealFade ?? 0.02);
    }
    const random = o.random ?? Math.random;
    const vary = (value: number, variation = 0) =>
      variation ? value * (1 + variation * (2 * random() - 1)) : value;
    const voice = this.engine.play(this.pick(random), {
      bus: o.bus,
      volume: vary(o.volume ?? 1, o.volumeVariation),
      pitch: vary(o.pitch ?? 1, o.pitchVariation),
      pan: o.pan,
      fadeIn: o.fadeIn,
      spatial: o.spatial,
    });
    this._voices.push(voice);
    this._playedAt = time;
    return voice;
  }

  /** Plays a variation placed in the world at `position`. */
  playAt(
    position: Partial<IVec3>,
    options: SoundEffectOptions = {},
  ): Voice | undefined {
    const spatial: SpatialOptions = {
      ...this.options.spatial,
      ...options.spatial,
      position,
    };
    return this.play({ ...options, spatial });
  }

  /** Stops the voices of the effect. */
  stop(fadeOut = 0): void {
    for (const voice of this._voices) {
      voice.stop(fadeOut);
    }
    this._voices.length = 0;
  }

  private pick(random: () => number): AudioSource {
    const count = this.sources.length;
    if (count === 1) {
      return this.sources[0];
    }
    let index: number;
    if (this._last < 0) {
      index = Math.min(Math.floor(random() * count), count - 1);
    } else {
      // Another than the last one.
      index = Math.min(Math.floor(random() * (count - 1)), count - 2);
      if (index >= this._last) {
        index++;
      }
    }
    this._last = index;
    return this.sources[index];
  }

  private prune(): void {
    for (let i = this._voices.length - 1; i >= 0; i--) {
      if (this._voices[i].state === 'stopped') {
        this._voices.splice(i, 1);
      }
    }
  }
}
