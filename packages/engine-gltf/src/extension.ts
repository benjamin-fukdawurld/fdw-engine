import type {
  ModelData,
  ModelNodeData,
  PbrMaterialData,
  TextureRef,
} from '@fdw/engine-assets';
import type { ResourceUri } from '@fdw/engine-resources';
import type { GltfOptions } from './options';
import type {
  GltfBufferView,
  GltfJson,
  GltfMaterial,
  GltfNode,
  GltfPrimitive,
  GltfTexture,
  GltfTextureInfo,
} from './types';

/** The typed arrays of the accessors, as glTF stores them (little-endian). */
export type GltfTypedArray =
  | Int8Array<ArrayBuffer>
  | Uint8Array<ArrayBuffer>
  | Int16Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>;

/**
 * The values of an accessor or of a decoded attribute, tightly packed:
 * `components` values per element.
 */
export interface GltfAttributeData {
  readonly array: GltfTypedArray;
  readonly components: number;
  /** Integers read as [0, 1] (unsigned) or [-1, 1] (signed) floats. */
  readonly normalized?: boolean;
}

/** A primitive decoded by an extension (Draco): its attributes by glTF name, its indices. */
export interface GltfDecodedPrimitive {
  readonly attributes: Readonly<Record<string, GltfAttributeData>>;
  readonly indices?: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
}

/** What the extensions see of the file being loaded. */
export interface GltfContext {
  readonly uri: ResourceUri;
  readonly json: GltfJson;
  readonly signal: AbortSignal;
  readonly options: GltfOptions;
  warn(message: string): void;
  /** The bytes of a buffer: the BIN chunk of a GLB, a data URI or a file. */
  buffer(index: number): Promise<Uint8Array<ArrayBuffer>>;
  /** The bytes of a buffer view, decoded by the extensions (meshopt). */
  bufferView(index: number): Promise<Uint8Array<ArrayBuffer>>;
}

/**
 * An extension of glTF, as a module: a name and hooks. A hook is called only
 * for the objects that carry the extension, with its JSON (`ext`), so an
 * extension never looks for itself. The hooks of the property-like
 * extensions return a modified copy of the data they get; the decoding ones
 * return what they decoded.
 */
export interface GltfExtension {
  readonly name: string;
  /**
   * Whether the extension can be used for this file (its decoder given,
   * ready). False makes a required extension fail the load with its name,
   * and an optional one ignored with a warning (the file has a fallback).
   */
  prepare?(context: GltfContext): boolean | Promise<boolean>;
  /** The decoded bytes of a buffer view (`EXT_meshopt_compression`). */
  bufferView?(
    ext: unknown,
    view: GltfBufferView,
    context: GltfContext
  ): Promise<Uint8Array<ArrayBuffer>>;
  /** The decoded geometry of a primitive (`KHR_draco_mesh_compression`). */
  primitive?(
    ext: unknown,
    primitive: GltfPrimitive,
    context: GltfContext
  ): Promise<GltfDecodedPrimitive>;
  material?(
    ext: unknown,
    data: PbrMaterialData,
    context: GltfContext,
    material: GltfMaterial
  ): PbrMaterialData;
  /** The image of a texture, instead of its `source` (`KHR_texture_basisu`). */
  textureSource?(
    ext: unknown,
    texture: GltfTexture,
    context: GltfContext
  ): number | undefined;
  /** A texture as a material reads it (`KHR_texture_transform`). */
  textureInfo?(
    ext: unknown,
    ref: TextureRef,
    context: GltfContext,
    info: GltfTextureInfo
  ): TextureRef;
  node?(
    ext: unknown,
    data: ModelNodeData,
    context: GltfContext,
    node: GltfNode
  ): ModelNodeData;
  /** The model, with the extension of the root object (`KHR_lights_punctual`). */
  model?(ext: unknown, data: ModelData, context: GltfContext): ModelData;
}
