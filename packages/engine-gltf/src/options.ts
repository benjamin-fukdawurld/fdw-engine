import { defineServiceKey } from '@fdw/engine-resources';
import type { GltfAttributeData, GltfExtension } from './extension';

/**
 * The decoder of `EXT_meshopt_compression`: the `MeshoptDecoder` of the
 * `meshoptimizer` package fits as is (`installGltf(store, { meshopt: MeshoptDecoder })`).
 */
export interface MeshoptDecoder {
  readonly ready: Promise<void>;
  decodeGltfBuffer(
    target: Uint8Array,
    count: number,
    size: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ): void;
}

/**
 * The decoder of `KHR_draco_mesh_compression`, which the application writes
 * over its Draco build (`draco3d`, a WASM module):
 *
 * ```ts
 * const draco: DracoDecoder = {
 *   async decode(bytes, attributes) {
 *     const decoder = new module.Decoder();
 *     const mesh = new module.Mesh();
 *     decoder.DecodeArrayToMesh(bytes, bytes.byteLength, mesh);
 *     // For each [name, id] of `attributes`: GetAttributeByUniqueId(mesh, id),
 *     // then GetAttributeDataArrayForAllPoints → { array, components, normalized }.
 *     // GetTrianglesUInt32Array → indices.
 *   },
 * };
 * ```
 */
export interface DracoDecoder {
  /**
   * Decodes a Draco mesh. `attributes` maps the glTF names of the
   * attributes (`POSITION`, `TEXCOORD_0`) to their Draco unique ids; the
   * result has them under the same names.
   */
  decode(
    bytes: Uint8Array<ArrayBuffer>,
    attributes: Readonly<Record<string, number>>,
  ): Promise<{
    readonly attributes: Readonly<Record<string, GltfAttributeData>>;
    readonly indices?: Uint32Array<ArrayBuffer>;
  }>;
}

export interface GltfOptions {
  /** Extensions added to the built-in ones (`gltfExtensions`); one of the same name replaces it. */
  readonly extensions?: readonly GltfExtension[];
  readonly meshopt?: MeshoptDecoder;
  readonly draco?: DracoDecoder;
  /** Receives the warnings (an optional extension ignored, a primitive of lines skipped). */
  readonly warn?: (message: string) => void;
}

/** The configuration of the glTF loader, provided by `installGltf`. */
export interface GltfConfig {
  /** By name: the built-in extensions and those of the options. */
  readonly extensions: ReadonlyMap<string, GltfExtension>;
  readonly options: GltfOptions;
}

export const GltfConfigService = defineServiceKey<GltfConfig>('gltf-config');
