import {
  defineResourceType,
  defineServiceKey,
  ResourceError,
  type ResourceLoader,
  type ResourceStore,
} from '@fdw/engine-resources';
import type { AudioClip, AudioEngine, AudioStream } from './api';
import { audioMimeTypes, sniffAudioFormat } from './formats';

/** The audio engine of a store, which decodes the sounds it loads. */
export const AudioEngineService = defineServiceKey<AudioEngine>('audio-engine');

/** A sound decoded at its load: `store.load(AudioClipType, 'shot.wav')`. */
export const AudioClipType = defineResourceType<AudioClip>('audio-clip');

/** A sound kept encoded, decoded while playing: a music. */
export const AudioStreamType = defineResourceType<AudioStream>('audio-stream');

const extensions = ['wav', 'ogg', 'oga', 'mp3', 'flac'];
const mimeTypes = [...Object.values(audioMimeTypes), 'audio/x-wav'];
const sniff = (head: Uint8Array) => sniffAudioFormat(head) !== undefined;

async function decode<T>(
  run: () => Promise<T>,
  uri: string,
  signal: AbortSignal,
): Promise<T> {
  let value: T;
  try {
    value = await run();
  } catch (e) {
    if (signal.aborted) throw new ResourceError('aborted', uri);
    throw new ResourceError(
      'decode',
      uri,
      `Cannot decode the sound: ${(e as Error).message}`,
      { cause: e },
    );
  }
  return value;
}

/** Decodes a WAV, Ogg Vorbis, MP3 or FLAC file into a clip. */
export const audioClipLoader: ResourceLoader<AudioClip> = {
  type: AudioClipType,
  extensions,
  mimeTypes,
  sniff,
  async load(context) {
    const engine = context.service(AudioEngineService);
    const bytes = await context.bytes();
    const clip = await decode(
      () => engine.decodeClip(bytes, { signal: context.signal }),
      context.uri,
      context.signal,
    );
    if (context.signal.aborted) {
      clip.dispose();
      throw new ResourceError('aborted', context.uri);
    }
    return clip;
  },
  dispose: (clip) => clip.dispose(),
  sizeOf: (clip) => clip.byteLength,
};

/** Keeps a WAV, Ogg Vorbis, MP3 or FLAC file encoded, to stream it. */
export const audioStreamLoader: ResourceLoader<AudioStream> = {
  type: AudioStreamType,
  extensions,
  mimeTypes,
  sniff,
  async load(context) {
    const engine = context.service(AudioEngineService);
    const bytes = await context.bytes();
    const stream = await decode(
      () => engine.createStream(bytes, { signal: context.signal }),
      context.uri,
      context.signal,
    );
    if (context.signal.aborted) {
      stream.dispose();
      throw new ResourceError('aborted', context.uri);
    }
    return stream;
  },
  dispose: (stream) => stream.dispose(),
  sizeOf: (stream) => stream.byteLength,
};

/**
 * Registers the loaders of the sounds in a store, and the engine that
 * decodes them: `AudioClipType` (decoded at the load, the short sounds) and
 * `AudioStreamType` (decoded while playing, the musics).
 */
export function installAudio(
  store: ResourceStore,
  engine: AudioEngine,
): ResourceStore {
  return store
    .registerLoader(audioClipLoader)
    .registerLoader(audioStreamLoader)
    .provideService(AudioEngineService, engine);
}
