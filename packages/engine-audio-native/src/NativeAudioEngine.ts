import {
  AudioListenerPose,
  isUnder,
  resolvePlay,
  type AudioBus,
  type AudioClip,
  type AudioEngine,
  type AudioEngineState,
  type AudioSource,
  type AudioStream,
  type CreateBusOptions,
  type DecodeOptions,
  type PlayOptions,
  type Voice,
  type VoiceState,
} from '@fdw/engine-audio';
import {
  loadAddon,
  type AudioClipHandle,
  type AudioEngineHandle,
  type AudioStreamHandle,
  type NativeAudioAddon,
} from '@fdw/engine-native';

const Param = { volume: 0, pitch: 1, pan: 2, loop: 3 } as const;
const Models = { inverse: 0, linear: 1, exponential: 2 } as const;
const States: readonly VoiceState[] = ['stopped', 'playing', 'paused'];

class NativeBus implements AudioBus {
  private _volume: number;
  private _muted = false;

  constructor(
    private readonly _engine: NativeAudioEngine,
    readonly id: number,
    readonly name: string,
    readonly parent: AudioBus | undefined,
    volume: number,
  ) {
    this._volume = volume;
    this.apply();
  }

  get volume(): number {
    return this._volume;
  }

  set volume(volume: number) {
    this._volume = volume;
    this.apply();
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(muted: boolean) {
    this._muted = muted;
    this.apply();
  }

  stopAll(fadeOut = 0): void {
    for (const voice of [...this._engine.voices]) {
      if (isUnder(voice.bus, this)) {
        voice.stop(fadeOut);
      }
    }
  }

  private apply(): void {
    this._engine.call((a, h) =>
      a.audioBusVolume(h, this.id, this._muted ? 0 : this._volume),
    );
  }
}

class NativeClip implements AudioClip {
  readonly kind = 'clip';
  readonly frames: number;
  readonly channels: number;
  readonly sampleRate: number;
  private _handle?: AudioClipHandle;

  constructor(
    private readonly _addon: NativeAudioAddon,
    handle: AudioClipHandle,
  ) {
    this._handle = handle;
    [this.frames, this.channels, this.sampleRate] =
      _addon.audioClipInfo(handle);
  }

  get duration(): number {
    return this.frames / this.sampleRate;
  }

  get byteLength(): number {
    return this.frames * this.channels * 4;
  }

  get disposed(): boolean {
    return !this._handle;
  }

  /** @internal */
  get handle(): AudioClipHandle {
    if (!this._handle) {
      throw new Error('The clip is disposed');
    }
    return this._handle;
  }

  /** A copy of the samples, interleaved. */
  samples(): Float32Array<ArrayBuffer> {
    return this._addon.audioClipSamples(this.handle);
  }

  dispose(): void {
    if (this._handle) {
      this._addon.audioClipRelease(this._handle);
      this._handle = undefined;
    }
  }
}

class NativeStream implements AudioStream {
  readonly kind = 'stream';
  readonly duration: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteLength: number;
  private _handle?: AudioStreamHandle;

  constructor(
    private readonly _addon: NativeAudioAddon,
    handle: AudioStreamHandle,
  ) {
    this._handle = handle;
    const [duration, channels, sampleRate, bytes] =
      _addon.audioStreamInfo(handle);
    this.duration = duration < 0 ? NaN : duration;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.byteLength = bytes;
  }

  get disposed(): boolean {
    return !this._handle;
  }

  /** @internal */
  get handle(): AudioStreamHandle {
    if (!this._handle) {
      throw new Error('The stream is disposed');
    }
    return this._handle;
  }

  dispose(): void {
    if (this._handle) {
      this._addon.audioStreamRelease(this._handle);
      this._handle = undefined;
    }
  }
}

class NativeVoice implements Voice {
  readonly ended: Promise<void>;
  private _volume: number;
  private _pitch: number;
  private _pan: number;
  private _loop: boolean;
  private _ended = false;
  private _resolve!: () => void;

  constructor(
    private readonly _engine: NativeAudioEngine,
    readonly id: number,
    readonly source: AudioSource,
    readonly bus: AudioBus,
    readonly spatial: boolean,
    options: { volume: number; pitch: number; pan: number; loop: boolean },
  ) {
    this.ended = new Promise((resolve) => (this._resolve = resolve));
    this._volume = options.volume;
    this._pitch = options.pitch;
    this._pan = options.pan;
    this._loop = options.loop;
  }

  get state(): VoiceState {
    return this._ended
      ? 'stopped'
      : States[this._engine.call((a, h) => a.audioVoiceState(h, this.id))];
  }

  get time(): number {
    return this._ended
      ? 0
      : this._engine.call((a, h) => a.audioVoiceTime(h, this.id));
  }

  get volume(): number {
    return this._volume;
  }

  set volume(volume: number) {
    this._volume = volume;
    this.set(Param.volume, volume);
  }

  get pitch(): number {
    return this._pitch;
  }

  set pitch(pitch: number) {
    this._pitch = pitch;
    this.set(Param.pitch, pitch);
  }

  get pan(): number {
    return this._pan;
  }

  set pan(pan: number) {
    this._pan = pan;
    this.set(Param.pan, pan);
  }

  get loop(): boolean {
    return this._loop;
  }

  set loop(loop: boolean) {
    this._loop = loop;
    this.set(Param.loop, loop ? 1 : 0);
  }

  setPosition(x: number, y: number, z: number): void {
    if (!this._ended) {
      this._engine.call((a, h) => a.audioVoicePosition(h, this.id, x, y, z));
    }
  }

  fadeTo(gain: number, seconds: number): void {
    if (!this._ended) {
      this._engine.call((a, h) => a.audioVoiceFade(h, this.id, gain, seconds));
    }
  }

  pause(): void {
    if (!this._ended) {
      this._engine.call((a, h) => a.audioVoicePause(h, this.id, 1));
    }
  }

  resume(): void {
    if (!this._ended) {
      this._engine.call((a, h) => a.audioVoicePause(h, this.id, 0));
    }
  }

  stop(fadeOut = 0): void {
    if (!this._ended) {
      this._engine.call((a, h) => a.audioVoiceStop(h, this.id, fadeOut));
    }
  }

  /** @internal Freed by the engine. */
  end(): void {
    this._ended = true;
    this._resolve();
  }

  private set(param: number, value: number): void {
    if (!this._ended) {
      this._engine.call((a, h) => a.audioVoiceSet(h, this.id, param, value));
    }
  }
}

export interface NativeAudioEngineOptions {
  /** Default: the rate of the device (48000 offline). */
  readonly sampleRate?: number;
  /** Default: the channels of the device (2 offline). */
  readonly channels?: number;
  /**
   * No device: the mix is read by `render` (tests, a sound rendered to a
   * file). Default false.
   */
  readonly offline?: boolean;
  /** For tests. Default the addon of `@fdw/engine-native`. */
  readonly addon?: NativeAudioAddon;
}

/**
 * The audio engine of the native platforms: miniaudio, in the addon of
 * `@fdw/engine-native`. It mixes on its own thread, on the default device
 * (PulseAudio, ALSA, CoreAudio, WASAPI…, a null device when there is none);
 * the clips and streams decode on the thread pool of libuv.
 *
 * ```ts
 * const engine = new NativeAudioEngine();
 * const clip = await engine.decodeClip(await readFile('shot.wav'));
 * engine.play(clip);
 * // At each frame:
 * engine.update();
 * ```
 */
export class NativeAudioEngine implements AudioEngine {
  readonly name = 'miniaudio';
  readonly sampleRate: number;
  readonly channels: number;
  readonly offline: boolean;
  readonly master: AudioBus;
  readonly listener: AudioListenerPose;
  private _handle?: AudioEngineHandle;
  private _state: AudioEngineState = 'running';
  private readonly _addon: NativeAudioAddon;
  private readonly _buses = new Map<string, NativeBus>();
  private readonly _voices: NativeVoice[] = [];
  private readonly _byId = new Map<number, NativeVoice>();
  private readonly _ended = new Int32Array(256);
  private readonly _pose = new Float32Array(9);
  private readonly _params = new Float32Array(15);

  constructor(options: NativeAudioEngineOptions = {}) {
    this._addon = options.addon ?? loadAddon();
    this.offline = options.offline ?? false;
    this._handle = this._addon.audioCreate(
      options.sampleRate ?? 0,
      options.channels ?? 0,
      this.offline ? 1 : 0,
    );
    [this.sampleRate, this.channels] = this._addon.audioInfo(this._handle);
    this.master = new NativeBus(this, 0, 'master', undefined, 1);
    this._buses.set('master', this.master as NativeBus);
    this.listener = new AudioListenerPose((listener) => {
      const pose = this._pose;
      const { position: p, forward: f, up: u } = listener;
      pose.set([p.x, p.y, p.z, f.x, f.y, f.z, u.x, u.y, u.z]);
      this.call((a, h) => a.audioListener(h, pose));
    });
  }

  get state(): AudioEngineState {
    return this._state;
  }

  get time(): number {
    return this._handle ? this._addon.audioTime(this._handle) : 0;
  }

  get voices(): readonly Voice[] {
    return this._voices;
  }

  /** @internal Calls the addon with the engine, unless destroyed. */
  call<T>(run: (addon: NativeAudioAddon, handle: AudioEngineHandle) => T): T {
    if (!this._handle) {
      throw new Error('The audio engine is destroyed');
    }
    return run(this._addon, this._handle);
  }

  createBus(name: string, options: CreateBusOptions = {}): AudioBus {
    if (this._buses.has(name)) {
      throw new Error(`The bus "${name}" exists`);
    }
    const parent = (options.parent ?? this.master) as NativeBus;
    const id = this.call((a, h) => a.audioBusCreate(h, parent.id));
    if (id < 0) {
      throw new Error(`Cannot create the bus "${name}"`);
    }
    const bus = new NativeBus(this, id, name, parent, options.volume ?? 1);
    this._buses.set(name, bus);
    return bus;
  }

  bus(name: string): AudioBus | undefined {
    return this._buses.get(name);
  }

  createClip(channels: readonly Float32Array[], sampleRate: number): AudioClip {
    const count = channels.length;
    const frames = channels[0]?.length ?? 0;
    const samples = new Float32Array(frames * count);
    for (let c = 0; c < count; c++) {
      const channel = channels[c];
      for (let i = 0; i < frames; i++) {
        samples[i * count + c] = channel[i];
      }
    }
    return new NativeClip(
      this._addon,
      this._addon.audioClipCreate(samples, count, sampleRate),
    );
  }

  async decodeClip(
    bytes: Uint8Array,
    { signal }: DecodeOptions = {},
  ): Promise<AudioClip> {
    signal?.throwIfAborted();
    const clip = new NativeClip(
      this._addon,
      await this._addon.audioDecode(bytes),
    );
    // The pool cannot be interrupted: the result is dropped.
    if (signal?.aborted) {
      clip.dispose();
      signal.throwIfAborted();
    }
    return clip;
  }

  async createStream(
    bytes: Uint8Array,
    { signal }: DecodeOptions = {},
  ): Promise<AudioStream> {
    signal?.throwIfAborted();
    const stream = new NativeStream(
      this._addon,
      await this._addon.audioStreamCreate(bytes),
    );
    if (signal?.aborted) {
      stream.dispose();
      signal.throwIfAborted();
    }
    return stream;
  }

  play(source: AudioSource, options: PlayOptions = {}): Voice {
    if (!(source instanceof NativeClip || source instanceof NativeStream)) {
      throw new Error('The sound comes from another audio engine');
    }
    const bus = (options.bus ?? this.master) as NativeBus;
    const o = resolvePlay(options);
    const s = o.spatial;
    const p = this._params;
    p[0] = o.volume;
    p[1] = o.pitch;
    p[2] = o.pan;
    p[3] = o.loop ? 1 : 0;
    p[4] = o.offset;
    p[5] = o.fadeIn;
    p[6] = o.paused ? 1 : 0;
    p[7] = o.isSpatial ? 1 : 0;
    p[8] = s.position.x;
    p[9] = s.position.y;
    p[10] = s.position.z;
    p[11] = s.refDistance;
    p[12] = s.maxDistance;
    p[13] = s.rolloff;
    p[14] = Models[s.distanceModel];
    const id = this.call((a, h) => a.audioPlay(h, source.handle, bus.id, p));
    if (id < 0) {
      throw new Error('Cannot play the sound: too many voices');
    }
    const voice = new NativeVoice(this, id, source, bus, o.isSpatial, o);
    this._voices.push(voice);
    this._byId.set(id, voice);
    return voice;
  }

  /**
   * Mixes the next `out.length / channels` frames into `out`, interleaved:
   * for an engine created `offline`. Returns the frames written.
   */
  render(out: Float32Array): number {
    if (!this.offline) {
      throw new Error('Only an offline engine renders');
    }
    return this.call((a, h) => a.audioRender(h, out));
  }

  async resume(): Promise<void> {
    if (this._handle && this._addon.audioSetRunning(this._handle, 1)) {
      this._state = 'running';
    }
  }

  async suspend(): Promise<void> {
    if (this._handle && this._addon.audioSetRunning(this._handle, 0)) {
      this._state = 'suspended';
    }
  }

  update(): void {
    if (!this._handle) {
      return;
    }
    const ended = this._ended;
    let count: number;
    do {
      count = this._addon.audioUpdate(this._handle, ended);
      for (let i = 0; i < count; i++) {
        const voice = this._byId.get(ended[i]);
        if (voice) {
          this._byId.delete(ended[i]);
          this._voices.splice(this._voices.indexOf(voice), 1);
          voice.end();
        }
      }
    } while (count === ended.length);
  }

  destroy(): void {
    if (!this._handle) {
      return;
    }
    this._addon.audioDestroy(this._handle);
    this._handle = undefined;
    this._state = 'closed';
    for (const voice of this._voices) {
      voice.end();
    }
    this._voices.length = 0;
    this._byId.clear();
  }
}
