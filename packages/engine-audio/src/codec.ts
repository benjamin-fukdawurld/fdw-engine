import type { ComponentCodec, ResourceRef } from '@fdw/engine-scene-io';
import type { AudioSource } from './api';
import type { SceneAudio, SoundEmitterDesc } from './SceneAudio';
import { AudioClipType, AudioStreamType } from './resources';

/** The data of a `sound emitter`: its description, the source by its URI. */
export type SoundEmitterData = Omit<SoundEmitterDesc, 'source'> & {
  readonly source: ResourceRef;
  /** Kept encoded, decoded while playing (AudioStreamType). */
  readonly stream?: boolean;
};

/**
 * The codec of the sounds of the nodes of a SceneAudio: their sources by
 * URI (a sound made by code is not saved), loaded as clips or streams.
 */
export function soundEmitterCodec(
  audio: SceneAudio,
): ComponentCodec<SoundEmitterData> {
  return {
    name: audio.SoundEmitter.name,
    version: 1,
    write(entity, ctx) {
      const desc = audio.SoundEmitter.desc[entity] as SoundEmitterDesc;
      const source = ctx.resource(desc.source);
      if (source === undefined) {
        ctx.warn(`sound emitter of entity ${entity}: its source has no URI`);
        return undefined;
      }
      return {
        ...desc,
        source,
        ...(desc.source.kind === 'stream' ? { stream: true } : {}),
      };
    },
    async read(data, entity, ctx) {
      const { stream, ...desc } = data;
      const source: AudioSource = stream
        ? await ctx.load(AudioStreamType, data.source)
        : await ctx.load(AudioClipType, data.source);
      audio.addEmitter(ctx.scene.node(entity), { ...desc, source });
    },
  };
}
