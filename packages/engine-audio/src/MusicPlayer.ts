import type { AudioBus, AudioEngine, AudioSource, Voice } from './api';

export interface MusicPlayerOptions {
  /** Where the music is mixed. Default the master bus. */
  readonly bus?: AudioBus;
  /** The seconds of a crossfade between two tracks. Default 2. */
  readonly crossfade?: number;
  /** Default 1. */
  readonly volume?: number;
}

export interface PlayTrackOptions {
  /** Overrides the crossfade of the player. */
  readonly crossfade?: number;
  /** Default the volume of the player. */
  readonly volume?: number;
  /** Default true: a music loops. */
  readonly loop?: boolean;
  /** Starts at, in seconds. */
  readonly offset?: number;
  /** Plays it again from the start if it is the one playing. Default false. */
  readonly restart?: boolean;
}

/**
 * One music at a time, crossfaded: the new track rises while the previous
 * one falls, over the same seconds. Streams are made for it (decoded while
 * playing), clips work too.
 *
 * ```ts
 * const music = new MusicPlayer(engine, { bus: musicBus, crossfade: 2 });
 * music.play(explore);
 * // A fight starts:
 * music.play(fight, { crossfade: 0.5 });
 * ```
 */
export class MusicPlayer {
  crossfade: number;
  volume: number;
  readonly bus: AudioBus | undefined;
  private _voice?: Voice;
  private _track?: AudioSource;

  constructor(
    readonly engine: AudioEngine,
    options: MusicPlayerOptions = {},
  ) {
    this.bus = options.bus;
    this.crossfade = options.crossfade ?? 2;
    this.volume = options.volume ?? 1;
  }

  /** The track playing or paused, until it ends or stops. */
  get track(): AudioSource | undefined {
    return this._voice?.state === 'stopped' ? undefined : this._track;
  }

  /** The voice of the current track. */
  get voice(): Voice | undefined {
    return this._voice?.state === 'stopped' ? undefined : this._voice;
  }

  /** Crossfades to `track`; nothing when it is the one playing. */
  play(track: AudioSource, options: PlayTrackOptions = {}): Voice {
    const current = this.voice;
    if (current && this._track === track && !options.restart) {
      current.resume();
      return current;
    }
    const fade = options.crossfade ?? this.crossfade;
    current?.stop(fade);
    this._track = track;
    this._voice = this.engine.play(track, {
      bus: this.bus,
      volume: options.volume ?? this.volume,
      loop: options.loop ?? true,
      offset: options.offset,
      // Rises only when another one falls.
      fadeIn: current ? fade : 0,
    });
    return this._voice;
  }

  /** Fades the music out. */
  stop(fadeOut = this.crossfade): void {
    this._voice?.stop(fadeOut);
    this._voice = undefined;
    this._track = undefined;
  }

  pause(): void {
    this._voice?.pause();
  }

  resume(): void {
    this._voice?.resume();
  }
}
