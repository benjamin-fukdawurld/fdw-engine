import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The Node-API addon (native/src/node_window.c), built by scripts/build.mjs.

/** An opaque handle of a native window. */
export type WindowHandle = { readonly __window: unique symbol };

/** An event of a native window, as read from the addon. */
export interface RawWindowEvent {
  readonly type:
    | 'close'
    | 'resize'
    | 'keydown'
    | 'keyup'
    | 'pointermove'
    | 'pointerdown'
    | 'pointerup'
    | 'wheel'
    | 'gamepadconnected'
    | 'gamepaddisconnected'
    | 'blur';
  readonly window: number;
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly dx?: number;
  readonly dy?: number;
  readonly button?: number;
  readonly key?: string;
  // The physical position of the key, as the `code` of the DOM.
  readonly code?: string;
  readonly repeat?: number;
  // The id of the gamepad of a gamepad event.
  readonly gamepad?: number;
  readonly modifiers?: number;
}

/**
 * The audio of the addon (native/include/fdw/audio.h, over miniaudio): what
 * @fdw/engine-audio-native reads.
 */
export interface NativeAudioAddon {
  // An engine on the default device, or without device (offline: 1), the
  // mix then read by audioRender. 0: the rate and channels of the device.
  audioCreate(
    sampleRate: number,
    channels: number,
    offline: number,
  ): AudioEngineHandle;
  audioDestroy(engine: AudioEngineHandle): void;
  // [sampleRate, channels].
  audioInfo(engine: AudioEngineHandle): [number, number];
  // The clock of the mix, in seconds.
  audioTime(engine: AudioEngineHandle): number;
  audioSetRunning(engine: AudioEngineHandle, running: number): boolean;
  // Mixes out.length / channels frames into out; returns the frames.
  audioRender(engine: AudioEngineHandle, out: Float32Array): number;
  // A bus under `parent` (0: the master); its id, or -1.
  audioBusCreate(engine: AudioEngineHandle, parent: number): number;
  audioBusVolume(engine: AudioEngineHandle, bus: number, volume: number): void;
  // The position, the forward and the up of the listener (9 floats).
  audioListener(engine: AudioEngineHandle, pose: Float32Array): void;
  // A clip of interleaved samples, copied.
  audioClipCreate(
    samples: Float32Array,
    channels: number,
    sampleRate: number,
  ): AudioClipHandle;
  // A WAV, FLAC, MP3 or Ogg Vorbis file decoded on the thread pool.
  audioDecode(bytes: Uint8Array): Promise<AudioClipHandle>;
  // [frames, channels, sampleRate].
  audioClipInfo(clip: AudioClipHandle): [number, number, number];
  // A copy of the interleaved samples.
  audioClipSamples(clip: AudioClipHandle): Float32Array<ArrayBuffer>;
  // Freed once the voices playing it are done.
  audioClipRelease(clip: AudioClipHandle): void;
  // The bytes of a file kept encoded, decoded by each voice as it plays.
  audioStreamCreate(bytes: Uint8Array): Promise<AudioStreamHandle>;
  // [duration (-1: unknown), channels, sampleRate, bytes].
  audioStreamInfo(stream: AudioStreamHandle): [number, number, number, number];
  audioStreamRelease(stream: AudioStreamHandle): void;
  // The id of the voice, or -1. params: volume, pitch, pan, loop, offset,
  // fadeIn, paused, spatial, x, y, z, refDistance, maxDistance, rolloff,
  // distanceModel (0 inverse, 1 linear, 2 exponential).
  audioPlay(
    engine: AudioEngineHandle,
    source: AudioClipHandle | AudioStreamHandle,
    bus: number,
    params: Float32Array,
  ): number;
  // param: 0 volume, 1 pitch, 2 pan, 3 loop.
  audioVoiceSet(
    engine: AudioEngineHandle,
    voice: number,
    param: number,
    value: number,
  ): void;
  audioVoicePosition(
    engine: AudioEngineHandle,
    voice: number,
    x: number,
    y: number,
    z: number,
  ): void;
  audioVoiceFade(
    engine: AudioEngineHandle,
    voice: number,
    gain: number,
    seconds: number,
  ): void;
  audioVoicePause(
    engine: AudioEngineHandle,
    voice: number,
    paused: number,
  ): void;
  audioVoiceStop(
    engine: AudioEngineHandle,
    voice: number,
    seconds: number,
  ): void;
  audioVoiceTime(engine: AudioEngineHandle, voice: number): number;
  // 0 stopped, 1 playing, 2 paused.
  audioVoiceState(engine: AudioEngineHandle, voice: number): number;
  // Frees the voices that have ended, writes their ids; returns how many.
  audioUpdate(engine: AudioEngineHandle, ended: Int32Array): number;
  audioVoiceCount(engine: AudioEngineHandle): number;
}

export interface NativeAddon extends NativeAudioAddon {
  init(): void;
  quit(): void;
  createWindow(
    title: string,
    width: number,
    height: number,
    flags: number,
  ): WindowHandle;
  destroyWindow(window: WindowHandle): void;
  windowId(window: WindowHandle): number;
  // The size in pixels.
  windowSize(window: WindowHandle): [number, number];
  setTitle(window: WindowHandle, title: string): void;
  setVsync(window: WindowHandle, vsync: number): void;
  // Locks the pointer to the window (1), or releases it (0).
  setRelativeMouse(window: WindowHandle, enabled: number): void;
  // RGBA pixels, `stride` bytes per row.
  presentRgba(
    window: WindowHandle,
    pixels: Uint8Array,
    width: number,
    height: number,
    stride: number,
  ): void;
  pollEvents(): RawWindowEvent[];
  // The window system and the native handles of a window.
  nativeHandle(window: WindowHandle): NativeHandle;
  // The ids of the gamepads connected.
  gamepads(): number[];
  // The name of a gamepad, its buttons (17) and axes (4) written in the
  // standard layout; undefined when it is not connected.
  gamepadState(
    id: number,
    buttons: Float32Array,
    axes: Float32Array,
  ): string | undefined;
  // Shakes a gamepad, the motors from 0 to 1: false when it cannot.
  gamepadRumble(
    id: number,
    strong: number,
    weak: number,
    durationMs: number,
  ): boolean;
  // Decodes a PNG, JPEG, TGA, BMP, GIF (first frame) or HDR image with
  // stb_image, on the thread pool: RGBA pixels, floats for HDR images.
  decodeImage(bytes: Uint8Array): Promise<DecodedNativeImage>;
}

/** An opaque handle of a native audio engine. */
export type AudioEngineHandle = { readonly __audioEngine: unique symbol };
/** An opaque handle of decoded samples. */
export type AudioClipHandle = { readonly __audioClip: unique symbol };
/** An opaque handle of encoded bytes, decoded while playing. */
export type AudioStreamHandle = { readonly __audioStream: unique symbol };

/** An image decoded by the addon. */
export interface DecodedNativeImage {
  readonly width: number;
  readonly height: number;
  // The channels of the file (1 to 4); the pixels always have 4.
  readonly channels: number;
  readonly hdr: boolean;
  // RGBA, rows from the top, straight alpha.
  readonly pixels: Uint8Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
}

/** The window system of a window and its native handles. */
export interface NativeHandle {
  readonly system: 'x11' | 'wayland' | 'win32' | 'cocoa' | 'unknown';
  readonly display: bigint;
  readonly window: bigint;
}

// The flags of createWindow (include/fdw/window.h).
export const WindowFlags = {
  resizable: 1 << 0,
  hidden: 1 << 1,
  fullscreen: 1 << 2,
  vulkan: 1 << 3,
} as const;

// The modifiers of the events.
export const Modifiers = {
  shift: 1 << 0,
  ctrl: 1 << 1,
  alt: 1 << 2,
  meta: 1 << 3,
} as const;

let addon: NativeAddon | undefined;

/**
 * Loads the addon: build/fdw_native.node of the package, or the file given
 * by the FDW_NATIVE_ADDON environment variable.
 */
export function loadAddon(): NativeAddon {
  if (!addon) {
    const require = createRequire(import.meta.url);
    const path =
      process.env['FDW_NATIVE_ADDON'] ??
      fileURLToPath(new URL('../build/fdw_native.node', import.meta.url));
    try {
      addon = require(path) as NativeAddon;
    } catch (error) {
      throw new Error(
        `The native addon of @fdw/engine-native is not built (${path}): run "node packages/engine-native/scripts/build.mjs"`,
        { cause: error },
      );
    }
  }
  return addon;
}

/** Replaces the addon, for tests. */
export function setAddon(replacement: NativeAddon | undefined): void {
  addon = replacement;
}
