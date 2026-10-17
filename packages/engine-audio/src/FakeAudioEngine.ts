import type { IVec3 } from '@fdw/engine-backend';
import {
  isUnder,
  resolvePlay,
  type AudioBus,
  type AudioClip,
  type AudioEngine,
  type AudioEngineState,
  type AudioSource,
  type AudioStream,
  type CreateBusOptions,
  type PlayOptions,
  type ResolvedPlay,
  type Voice,
  type VoiceState,
} from './api';
import { AudioListenerPose } from './listener';

class FakeBus implements AudioBus {
  volume: number;
  muted = false;

  constructor(
    private readonly _engine: FakeAudioEngine,
    readonly name: string,
    readonly parent: AudioBus | undefined,
    volume: number,
  ) {
    this.volume = volume;
  }

  stopAll(fadeOut = 0): void {
    for (const voice of [...this._engine.voices]) {
      if (isUnder(voice.bus, this)) {
        voice.stop(fadeOut);
      }
    }
  }
}

/** A voice of the fake engine: its state moves with `engine.advance`. */
export class FakeVoice implements Voice {
  readonly ended: Promise<void>;
  volume: number;
  pitch: number;
  pan: number;
  loop: boolean;
  /** The position given last, for a spatial voice. */
  position: IVec3;
  /** The time of the engine when it was played. */
  readonly startedAt: number;
  private _state: VoiceState;
  private _time: number;
  // The fade: from `from` at `fadeStart` to `to` over `fadeLength`.
  private _fade = { from: 1, to: 1, start: 0, length: 0 };
  private _stopAt = Infinity;
  private _resolve!: () => void;

  constructor(
    private readonly _engine: FakeAudioEngine,
    readonly source: AudioSource,
    readonly bus: AudioBus,
    readonly options: ResolvedPlay,
  ) {
    this.ended = new Promise((resolve) => (this._resolve = resolve));
    this.volume = options.volume;
    this.pitch = options.pitch;
    this.pan = options.pan;
    this.loop = options.loop;
    this.position = { ...options.spatial.position };
    this.startedAt = _engine.time;
    this._time = options.offset;
    this._state = options.paused ? 'paused' : 'playing';
    if (options.fadeIn > 0) {
      this._fade = {
        from: 0,
        to: 1,
        start: _engine.time,
        length: options.fadeIn,
      };
    }
  }

  get spatial(): boolean {
    return this.options.isSpatial;
  }

  get state(): VoiceState {
    return this._state;
  }

  get time(): number {
    return this._time;
  }

  /** The gain of the fades now. */
  get fade(): number {
    const { from, to, start, length } = this._fade;
    const t = length > 0 ? (this._engine.time - start) / length : 1;
    return t >= 1 ? to : from + (to - from) * Math.max(t, 0);
  }

  /** Whether `stop` was called with a fade still running. */
  get stopping(): boolean {
    return this._stopAt !== Infinity && this._state !== 'stopped';
  }

  setPosition(x: number, y: number, z: number): void {
    this.position = { x, y, z };
  }

  fadeTo(gain: number, seconds: number): void {
    this._fade = {
      from: this.fade,
      to: gain,
      start: this._engine.time,
      length: seconds,
    };
  }

  pause(): void {
    if (this._state === 'playing' && !this.stopping) {
      this._state = 'paused';
    }
  }

  resume(): void {
    if (this._state === 'paused') {
      this._state = 'playing';
    }
  }

  stop(fadeOut = 0): void {
    if (this._state === 'stopped') {
      return;
    }
    if (fadeOut > 0 && this._state === 'playing') {
      this.fadeTo(0, fadeOut);
      this._stopAt = Math.min(this._stopAt, this._engine.time + fadeOut);
    } else {
      this._state = 'stopped';
    }
  }

  /** @internal The engine moved on by `dt`. */
  advance(dt: number): void {
    if (this._state !== 'playing') {
      return;
    }
    const duration = this.source.duration;
    this._time += dt * this.pitch;
    if (this._engine.time >= this._stopAt) {
      this._state = 'stopped';
    } else if (Number.isFinite(duration) && this._time >= duration) {
      if (this.loop && duration > 0) {
        this._time %= duration;
      } else {
        this._time = duration;
        this._state = 'stopped';
      }
    }
  }

  /** @internal */
  end(): void {
    this._state = 'stopped';
    this._resolve();
  }
}

class FakeClip implements AudioClip {
  readonly kind = 'clip';
  disposed = false;

  constructor(
    readonly duration: number,
    readonly sampleRate: number,
    readonly channels: number,
    readonly samples: readonly Float32Array[],
  ) {}

  get frames(): number {
    return Math.round(this.duration * this.sampleRate);
  }

  get byteLength(): number {
    return this.frames * this.channels * 4;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeStream implements AudioStream {
  readonly kind = 'stream';
  disposed = false;

  constructor(
    readonly duration: number,
    readonly byteLength: number,
  ) {}

  dispose(): void {
    this.disposed = true;
  }
}

export interface FakeAudioEngineOptions {
  /** The duration of the clips and streams decoded from bytes. Default 1. */
  readonly decodedDuration?: number;
  readonly sampleRate?: number;
  /** Starts suspended, as a page before a gesture. Default false. */
  readonly suspended?: boolean;
}

/**
 * An audio engine without sound, for the tests: the voices move with
 * `advance(seconds)`, end at the end of their source, and keep what they
 * were told (positions, fades, volumes).
 */
export class FakeAudioEngine implements AudioEngine {
  readonly name = 'fake';
  readonly sampleRate: number;
  readonly master: AudioBus;
  readonly listener = new AudioListenerPose(() => undefined);
  /** Every voice played, ended or not. */
  readonly played: FakeVoice[] = [];
  private _state: AudioEngineState;
  private _time = 0;
  private readonly _voices: FakeVoice[] = [];
  private readonly _buses = new Map<string, AudioBus>();
  private readonly _decodedDuration: number;

  constructor(options: FakeAudioEngineOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this._decodedDuration = options.decodedDuration ?? 1;
    this._state = options.suspended ? 'suspended' : 'running';
    this.master = new FakeBus(this, 'master', undefined, 1);
    this._buses.set('master', this.master);
  }

  get state(): AudioEngineState {
    return this._state;
  }

  get time(): number {
    return this._time;
  }

  get voices(): readonly FakeVoice[] {
    return this._voices;
  }

  createBus(name: string, options: CreateBusOptions = {}): AudioBus {
    if (this._buses.has(name)) {
      throw new Error(`The bus "${name}" exists`);
    }
    const bus = new FakeBus(
      this,
      name,
      options.parent ?? this.master,
      options.volume ?? 1,
    );
    this._buses.set(name, bus);
    return bus;
  }

  bus(name: string): AudioBus | undefined {
    return this._buses.get(name);
  }

  createClip(channels: readonly Float32Array[], sampleRate: number): AudioClip {
    return new FakeClip(
      (channels[0]?.length ?? 0) / sampleRate,
      sampleRate,
      channels.length,
      channels,
    );
  }

  async decodeClip(): Promise<AudioClip> {
    return new FakeClip(this._decodedDuration, this.sampleRate, 2, [
      new Float32Array(0),
      new Float32Array(0),
    ]);
  }

  async createStream(bytes: Uint8Array): Promise<AudioStream> {
    return new FakeStream(this._decodedDuration, bytes.byteLength);
  }

  play(source: AudioSource, options: PlayOptions = {}): FakeVoice {
    if (source.disposed) {
      throw new Error('The sound is disposed');
    }
    const voice = new FakeVoice(
      this,
      source,
      options.bus ?? this.master,
      resolvePlay(options),
    );
    this._voices.push(voice);
    this.played.push(voice);
    return voice;
  }

  async resume(): Promise<void> {
    if (this._state !== 'closed') {
      this._state = 'running';
    }
  }

  async suspend(): Promise<void> {
    if (this._state !== 'closed') {
      this._state = 'suspended';
    }
  }

  /** Moves the clock and the voices on by `seconds`, when running. */
  advance(seconds: number): void {
    if (this._state !== 'running') {
      return;
    }
    this._time += seconds;
    for (const voice of this._voices) {
      voice.advance(seconds);
    }
  }

  update(): void {
    for (let i = this._voices.length - 1; i >= 0; i--) {
      const voice = this._voices[i];
      if (voice.state === 'stopped') {
        this._voices.splice(i, 1);
        voice.end();
      }
    }
  }

  destroy(): void {
    for (const voice of this._voices) {
      voice.end();
    }
    this._voices.length = 0;
    this._state = 'closed';
  }
}
