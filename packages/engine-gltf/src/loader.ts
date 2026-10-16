import {
  AssetsConfigService,
  ModelDataType,
  type ModelData,
} from '@fdw/engine-assets';
import {
  ResourceError,
  type LoadContext,
  type ResourceLoader,
  type ServiceKey,
} from '@fdw/engine-resources';
import { gltfExtensions } from './extensions';
import { isGlb, parseGlb } from './glb';
import { GltfConfigService, type GltfConfig } from './options';
import { GltfReader } from './reader';
import type { GltfJson } from './types';

const defaultConfig: GltfConfig = {
  extensions: new Map(gltfExtensions.map((e) => [e.name, e])),
  options: {},
};

// A service the store may not have: the loader works without installGltf
// (the built-in extensions, no decoders) and without installAssets.
function optionalService<S>(
  ctx: LoadContext<unknown>,
  key: ServiceKey<S>,
): S | undefined {
  try {
    return ctx.service(key);
  } catch (e) {
    if (e instanceof ResourceError && e.code === 'unsupported')
      return undefined;
    throw e;
  }
}

/**
 * The models of glTF 2.0 files, `.gltf` (JSON, with external or `data:`
 * buffers and images) and `.glb` (binary). A pure loader: bytes in, CPU data
 * out (`ModelDataType`), no GPU. Each primitive is a `MeshData`
 * sub-resource, `model.glb#mesh/<mesh name or index>/<primitive>`, each
 * material a `PbrMaterialData`, `model.glb#material/<name or index>`, and
 * each embedded image its bytes, `model.glb#image/<index>`, which textures
 * load like any image.
 */
export const gltfLoader: ResourceLoader<ModelData> = {
  type: ModelDataType,
  extensions: ['gltf', 'glb'],
  mimeTypes: ['model/gltf+json', 'model/gltf-binary'],
  sniff: isGlb,
  async load(ctx) {
    const config = optionalService(ctx, GltfConfigService) ?? defaultConfig;
    const warn =
      config.options.warn ??
      optionalService(ctx, AssetsConfigService)?.warn ??
      ((m) => console.warn(`[gltf] ${m}`));
    const bytes = await ctx.bytes();
    let json: GltfJson;
    let bin: Uint8Array<ArrayBuffer> | undefined;
    try {
      if (isGlb(bytes)) ({ json, bin } = parseGlb(bytes));
      else json = JSON.parse(new TextDecoder().decode(bytes)) as GltfJson;
    } catch (e) {
      throw new ResourceError(
        'decode',
        ctx.uri,
        `${ctx.uri}: not a valid glTF file (${(e as Error).message})`,
        { cause: e },
      );
    }
    if (!json.asset?.version?.startsWith('2.')) {
      throw new ResourceError(
        'unsupported',
        ctx.uri,
        `${ctx.uri}: glTF version ${json.asset?.version} is not supported`,
      );
    }
    const reader = new GltfReader(ctx, json, bin, config, warn);
    await reader.prepare();
    ctx.signal.throwIfAborted();
    return reader.read();
  },
};
