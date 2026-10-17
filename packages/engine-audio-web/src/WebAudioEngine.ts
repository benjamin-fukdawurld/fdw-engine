import {
  AudioListenerPose,
  audioMimeTypes,
  isUnder,
  resolvePlay,
  sniffAudioFormat,
  type AudioBus,
  type AudioClip,
  type AudioEngine,
  type AudioEngineState,
  type AudioSource,
  type AudioStream,
  type CreateBusOptions,
  type DecodeOptions,
  type PlayOptions,
  type ResolvedPlay,
  type Voice,
  type VoiceState,
} from '@fdw/engine-audio';

class WebBus implements AudioBus {
  /** @internal The node the voices and the buses under it connect to. */
  readonly input: GainNode;
  private _volume: number;
  private _muted = false;

  constructor(
    private readonly _engine: WebAudioEngine,
    readonly name: string,
    readonly parent: WebBus | undefined,
    volume: number,
    destination: AudioNode,
  ) {
    this.input = _engine.context.createGain();
    this.input.connect(destination);
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
    this.input.gain.value = this._muted ? 0 : this._volume;
  }
}

class WebClip implements AudioClip {
  readonly kind = 'clip';
  private _buffer?: AudioBuffer;

  constructor(buffer: AudioBuffer) {
    this._buffer = buffer;
    this.duration = buffer.duration;
    this.sampleRate = buffer.sampleRate;
    this.channels = buffer.numberOfChannels;
    this.frames = buffer.length;
  }

  readonly duration: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;

  get byteLength(): number {
    return this.frames * this.channels * 4;
  }

  get disposed(): boolean {
    return !this._buffer;
  }

  /** The samples, for the nodes of WebAudio. */
  get buffer(): AudioBuffer {
    if (!this._buffer) {
      throw new Error('The clip is disposed');
    }
    return this._buffer;
  }

  dispose(): void {
    // The voices keep the buffer through their nodes.
    this._buffer = undefined;
  }
}

class WebStream implements AudioStream {
  readonly kind = 'stream';
  private _disposed = false;
  // The voices reading the URL: it is revoked after the last one.
  private _users = 0;

  /**
   * @param url An object URL of the bytes, streamed by media elements; or
   * @param buffer the bytes decoded, where a context has no media element
   * (an OfflineAudioContext).
   */
  constructor(
    readonly duration: number,
    readonly byteLength: number,
    readonly url?: string,
    readonly buffer?: AudioBuffer,
  ) {}

  get disposed(): boolean {
    return this._disposed;
  }

  /** @internal */
  use(): void {
    this._users++;
  }

  /** @internal */
  release(): void {
    this._users--;
    this.revoke();
  }

  dispose(): void {
    this._disposed = true;
    this.revoke();
  }

  private revoke(): void {
    if (this._disposed && this._users === 0 && this.url) {
      URL.revokeObjectURL(this.url);
    }
  }
}

class WebVoice implements Voice {
  readonly ended: Promise<void>;
  /** @internal The node the source connects to. */
  readonly gain: GainNode;
  private readonly _fade: GainNode;
  private readonly _panner: StereoPannerNode | PannerNode;
  private _state: VoiceState;
  private _volume: number;
  private _pitch: number;
  private _pan: number;
  private _loop: boolean;
  // A clip: its node, recreated at each resume; the time in the clip at
  // `_startedAt` (the clock of the context).
  private _node?: AudioBufferSourceNode;
  private _offset: number;
  private _startedAt = 0;
  // A stream: its element and its node.
  private _element?: HTMLAudioElement;
  private _media?: MediaElementAudioSourceNode;
  private _stopAt = Infinity;
  private _resolve!: () => void;

  constructor(
    private readonly _engine: WebAudioEngine,
    readonly source: AudioSource,
    readonly bus: WebBus,
    options: ResolvedPlay,
  ) {
    this.ended = new Promise((resolve) => (this._resolve = resolve));
    const context = _engine.context;
    this._volume = options.volume;
    this._pitch = options.pitch;
    this._pan = options.pan;
    this._loop = options.loop;
    this._offset = options.offset;
    this.gain = context.createGain();
    this.gain.gain.value = options.volume;
    this._fade = context.createGain();
    if (options.isSpatial) {
      const s = options.spatial;
      const panner = context.createPanner();
      panner.panningModel = _engine.panningModel;
      panner.distanceModel = s.distanceModel;
      panner.refDistance = s.refDistance;
      panner.maxDistance = s.maxDistance;
      panner.rolloffFactor = s.rolloff;
      this._panner = panner;
      this.setPosition(s.position.x, s.position.y, s.position.z);
    } else {
      const panner = context.createStereoPanner();
      // A mono source on both ears first, as natively: at the center, it
      // passes as it is.
      panner.channelCount = 2;
      panner.channelCountMode = 'explicit';
      panner.pan.value = options.pan;
      this._panner = panner;
    }
    this.gain.connect(this._fade).connect(this._panner).connect(bus.input);
    if (options.fadeIn > 0) {
      const now = context.currentTime;
      this._fade.gain.setValueAtTime(0, now);
      this._fade.gain.linearRampToValueAtTime(1, now + options.fadeIn);
    }
    if (source.kind === 'stream') {
      (source as WebStream).use();
    }
    this._state = options.paused ? 'paused' : 'playing';
    if (!options.paused) {
      this.start();
    }
  }

  get spatial(): boolean {
    return this._panner instanceof PannerNode;
  }

  get state(): VoiceState {
    return this._state;
  }

  get time(): number {
    if (this._element) {
      return this._element.currentTime;
    }
    if (this._state !== 'playing' || !this._node) {
      return this._offset;
    }
    const time =
      this._offset +
      (this._engine.context.currentTime - this._startedAt) * this._pitch;
    const duration = this.source.duration;
    return this._loop ? time % duration : Math.min(time, duration);
  }

  get volume(): number {
    return this._volume;
  }

  set volume(volume: number) {
    this._volume = volume;
    this.gain.gain.value = volume;
  }

  get pitch(): number {
    return this._pitch;
  }

  set pitch(pitch: number) {
    if (this._node) {
      // The time so far at the old rate.
      this._offset = this.time;
      this._startedAt = this._engine.context.currentTime;
      this._node.playbackRate.value = pitch;
    }
    if (this._element) {
      this._element.playbackRate = pitch;
    }
    this._pitch = pitch;
  }

  get pan(): number {
    return this._pan;
  }

  set pan(pan: number) {
    this._pan = pan;
    if (this._panner instanceof StereoPannerNode) {
      this._panner.pan.value = pan;
    }
  }

  get loop(): boolean {
    return this._loop;
  }

  set loop(loop: boolean) {
    if (this._node) {
      this._offset = this.time;
      this._startedAt = this._engine.context.currentTime;
      this._node.loop = loop;
    }
    if (this._element) {
      this._element.loop = loop;
    }
    this._loop = loop;
  }

  setPosition(x: number, y: number, z: number): void {
    const panner = this._panner;
    if (!(panner instanceof PannerNode)) {
      return;
    }
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else {
      panner.setPosition(x, y, z);
    }
  }

  fadeTo(gain: number, seconds: number): void {
    const param = this._fade.gain;
    const now = this._engine.context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    if (seconds > 0) {
      param.linearRampToValueAtTime(gain, now + seconds);
    } else {
      param.setValueAtTime(gain, now);
    }
  }

  pause(): void {
    if (this._state !== 'playing' || this._stopAt !== Infinity) {
      return;
    }
    if (this._node) {
      this._offset = this.time;
      this.dropNode();
    }
    this._element?.pause();
    this._state = 'paused';
  }

  resume(): void {
    if (this._state !== 'paused') {
      return;
    }
    this._state = 'playing';
    if (this._element) {
      this.playElement();
    } else {
      this.start();
    }
  }

  stop(fadeOut = 0): void {
    if (this._state === 'stopped') {
      return;
    }
    if (fadeOut > 0 && this._state === 'playing') {
      this.fadeTo(0, fadeOut);
      this._stopAt = this._engine.context.currentTime + fadeOut;
      // A clip stops by itself; a stream at `engine.update()`.
      this._node?.stop(this._stopAt);
    } else {
      this.finish();
    }
  }

  /** @internal Stops a stream past its stop, starts it again after a gesture. */
  poll(now: number, running: boolean): void {
    if (this._state !== 'playing') {
      return;
    }
    if (now >= this._stopAt) {
      this.finish();
    } else if (running && this._element?.paused && !this._element.ended) {
      this.playElement();
    }
  }

  /** @internal Disconnects everything; resolved at the next `update`. */
  finish(): void {
    if (this._state === 'stopped') {
      return;
    }
    this._state = 'stopped';
    this.dropNode();
    if (this._element) {
      this._element.pause();
      this._element.removeAttribute('src');
      this._element.load();
      this._media?.disconnect();
      this._element = undefined;
      this._media = undefined;
      (this.source as WebStream).release();
    }
    this.gain.disconnect();
    this._fade.disconnect();
    this._panner.disconnect();
  }

  /** @internal */
  end(): void {
    this._resolve();
  }

  private start(): void {
    const context = this._engine.context;
    const source = this.source;
    const buffer =
      source.kind === 'clip'
        ? (source as WebClip).buffer
        : (source as WebStream).buffer;
    if (buffer) {
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.loop = this._loop;
      node.playbackRate.value = this._pitch;
      node.connect(this.gain);
      node.onended = () => {
        if (this._node === node) {
          this.finish();
        }
      };
      this._node = node;
      this._startedAt = context.currentTime;
      node.start(this._startedAt, this._offset % buffer.duration);
      return;
    }
    // A stream, read by an element.
    const element = new Audio();
    element.src = (source as WebStream).url ?? '';
    element.preservesPitch = false;
    element.playbackRate = this._pitch;
    element.loop = this._loop;
    element.currentTime = this._offset;
    element.addEventListener('ended', () => {
      if (this._element === element && !element.loop) {
        this.finish();
      }
    });
    this._media = (context as AudioContext).createMediaElementSource(element);
    this._media.connect(this.gain);
    this._element = element;
    this.playElement();
  }

  private playElement(): void {
    // Refused before a gesture: tried again by `poll` once the engine runs.
    this._element?.play().catch(() => undefined);
  }

  private dropNode(): void {
    const node = this._node;
    if (node) {
      this._node = undefined;
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Not started, or already stopped.
      }
      node.disconnect();
    }
  }
}

export interface WebAudioEngineOptions {
  /**
   * The context: an `OfflineAudioContext` renders the mix into a buffer
   * (tests, a sound saved to a file). Default a new `AudioContext`, closed
   * by `destroy`.
   */
  readonly context?: BaseAudioContext;
  /** For a new context. Default `interactive`. */
  readonly latencyHint?: AudioContextLatencyCategory | number;
  /**
   * How the spatial voices are placed between the ears: `HRTF` sounds
   * better with headphones, costs more. Default `equalpower`.
   */
  readonly panningModel?: PanningModelType;
}

/**
 * The audio engine of a page: WebAudio. The clips are `AudioBuffer`s, the
 * streams media elements reading the bytes from an object URL, the buses
 * gain nodes, the spatial voices panner nodes.
 *
 * The browser starts the context only after a gesture: `resume()` from a
 * click or a key, or `unlockAudio(engine)`.
 */
export class WebAudioEngine implements AudioEngine {
  readonly name = 'webaudio';
  readonly context: BaseAudioContext;
  readonly master: AudioBus;
  readonly listener: AudioListenerPose;
  readonly panningModel: PanningModelType;
  private readonly _ownsContext: boolean;
  private readonly _buses = new Map<string, WebBus>();
  private readonly _voices: WebVoice[] = [];
  private _closed = false;

  constructor(options: WebAudioEngineOptions = {}) {
    this._ownsContext = !options.context;
    this.context =
      options.context ??
      new AudioContext({ latencyHint: options.latencyHint ?? 'interactive' });
    this.panningModel = options.panningModel ?? 'equalpower';
    this.master = new WebBus(
      this,
      'master',
      undefined,
      1,
      this.context.destination,
    );
    this._buses.set('master', this.master as WebBus);
    this.listener = new AudioListenerPose(({ position, forward, up }) => {
      const l = this.context.listener;
      if (l.positionX) {
        l.positionX.value = position.x;
        l.positionY.value = position.y;
        l.positionZ.value = position.z;
        l.forwardX.value = forward.x;
        l.forwardY.value = forward.y;
        l.forwardZ.value = forward.z;
        l.upX.value = up.x;
        l.upY.value = up.y;
        l.upZ.value = up.z;
      } else {
        l.setPosition(position.x, position.y, position.z);
        l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    });
  }

  get state(): AudioEngineState {
    if (this._closed || this.context.state === 'closed') {
      return 'closed';
    }
    return this.context.state === 'running' ? 'running' : 'suspended';
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get time(): number {
    return this.context.currentTime;
  }

  get voices(): readonly Voice[] {
    return this._voices;
  }

  createBus(name: string, options: CreateBusOptions = {}): AudioBus {
    if (this._buses.has(name)) {
      throw new Error(`The bus "${name}" exists`);
    }
    const parent = (options.parent ?? this.master) as WebBus;
    const bus = new WebBus(
      this,
      name,
      parent,
      options.volume ?? 1,
      parent.input,
    );
    this._buses.set(name, bus);
    return bus;
  }

  bus(name: string): AudioBus | undefined {
    return this._buses.get(name);
  }

  createClip(channels: readonly Float32Array[], sampleRate: number): AudioClip {
    const frames = channels[0]?.length ?? 0;
    const buffer = this.context.createBuffer(
      channels.length,
      Math.max(frames, 1),
      sampleRate,
    );
    channels.forEach((samples, c) =>
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, c),
    );
    return new WebClip(buffer);
  }

  async decodeClip(
    bytes: Uint8Array,
    { signal }: DecodeOptions = {},
  ): Promise<AudioClip> {
    signal?.throwIfAborted();
    const buffer = await this.decode(bytes);
    signal?.throwIfAborted();
    return new WebClip(buffer);
  }

  async createStream(
    bytes: Uint8Array,
    { signal }: DecodeOptions = {},
  ): Promise<AudioStream> {
    signal?.throwIfAborted();
    if (!('createMediaElementSource' in this.context)) {
      // No media element in an OfflineAudioContext: decoded at once.
      const buffer = await this.decode(bytes);
      signal?.throwIfAborted();
      return new WebStream(
        buffer.duration,
        bytes.byteLength,
        undefined,
        buffer,
      );
    }
    const format = sniffAudioFormat(bytes);
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: format ? audioMimeTypes[format] : '',
    });
    const url = URL.createObjectURL(blob);
    // The metadata, from an element: the duration, and whether it plays.
    const probe = new Audio();
    probe.preload = 'metadata';
    try {
      const duration = await new Promise<number>((resolve, reject) => {
        probe.addEventListener('loadedmetadata', () => resolve(probe.duration));
        probe.addEventListener('error', () =>
          reject(
            new Error(
              `The browser cannot play this sound (${format ?? 'unknown format'})`,
            ),
          ),
        );
        signal?.addEventListener('abort', () => reject(signal.reason));
        probe.src = url;
      });
      return new WebStream(
        Number.isFinite(duration) ? duration : NaN,
        blob.size,
        url,
      );
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    } finally {
      probe.removeAttribute('src');
      probe.load();
    }
  }

  play(source: AudioSource, options: PlayOptions = {}): Voice {
    if (!(source instanceof WebClip || source instanceof WebStream)) {
      throw new Error('The sound comes from another audio engine');
    }
    if (source.disposed) {
      throw new Error('The sound is disposed');
    }
    const bus = (options.bus ?? this.master) as WebBus;
    const voice = new WebVoice(this, source, bus, resolvePlay(options));
    this._voices.push(voice);
    return voice;
  }

  async resume(): Promise<void> {
    if (this.context instanceof AudioContext && !this._closed) {
      await this.context.resume();
    }
  }

  async suspend(): Promise<void> {
    if (this.context instanceof AudioContext && !this._closed) {
      await this.context.suspend();
    }
  }

  update(): void {
    const now = this.context.currentTime;
    const running = this.state === 'running';
    for (let i = this._voices.length - 1; i >= 0; i--) {
      const voice = this._voices[i];
      voice.poll(now, running);
      if (voice.state === 'stopped') {
        this._voices.splice(i, 1);
        voice.end();
      }
    }
  }

  destroy(): void {
    if (this._closed) {
      return;
    }
    for (const voice of this._voices) {
      voice.finish();
      voice.end();
    }
    this._voices.length = 0;
    this._closed = true;
    if (this._ownsContext && this.context instanceof AudioContext) {
      void this.context.close();
    }
  }

  private decode(bytes: Uint8Array): Promise<AudioBuffer> {
    // decodeAudioData takes the buffer away: a copy.
    return this.context.decodeAudioData(bytes.slice().buffer);
  }
}

/**
 * Resumes the engine at the first gesture on `target` (a click, a key, a
 * touch): the browsers start the audio only then. Returns what stops
 * listening.
 */
export function unlockAudio(
  engine: AudioEngine,
  target: EventTarget = window,
): () => void {
  const events = ['pointerdown', 'keydown', 'touchend'];
  const unlock = () => {
    void engine.resume().then(() => {
      if (engine.state === 'running') {
        stop();
      }
    });
  };
  const stop = () =>
    events.forEach((type) => target.removeEventListener(type, unlock));
  events.forEach((type) => target.addEventListener(type, unlock));
  return stop;
}
