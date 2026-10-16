// The JSON of a glTF 2.0 file, as far as the loader reads it. Every object
// may carry `extensions` (by name) and `extras`, which the loader ignores.

export interface GltfProperty {
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly extras?: unknown;
}

export interface GltfAsset extends GltfProperty {
  readonly version: string;
  readonly minVersion?: string;
  readonly generator?: string;
}

export interface GltfBuffer extends GltfProperty {
  readonly uri?: string;
  readonly byteLength: number;
  readonly name?: string;
}

export interface GltfBufferView extends GltfProperty {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
  readonly target?: number;
  readonly name?: string;
}

/** The component types of the accessors: the constants of OpenGL. */
export const GltfComponentType = {
  BYTE: 5120,
  UNSIGNED_BYTE: 5121,
  SHORT: 5122,
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  FLOAT: 5126,
} as const;

export type GltfAccessorType =
  | 'SCALAR'
  | 'VEC2'
  | 'VEC3'
  | 'VEC4'
  | 'MAT2'
  | 'MAT3'
  | 'MAT4';

export interface GltfAccessorSparse extends GltfProperty {
  readonly count: number;
  readonly indices: GltfProperty & {
    readonly bufferView: number;
    readonly byteOffset?: number;
    readonly componentType: number;
  };
  readonly values: GltfProperty & {
    readonly bufferView: number;
    readonly byteOffset?: number;
  };
}

export interface GltfAccessor extends GltfProperty {
  readonly bufferView?: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly normalized?: boolean;
  readonly count: number;
  readonly type: GltfAccessorType;
  readonly max?: readonly number[];
  readonly min?: readonly number[];
  readonly sparse?: GltfAccessorSparse;
  readonly name?: string;
}

export interface GltfImage extends GltfProperty {
  readonly uri?: string;
  readonly mimeType?: string;
  readonly bufferView?: number;
  readonly name?: string;
}

export interface GltfSampler extends GltfProperty {
  readonly magFilter?: number;
  readonly minFilter?: number;
  readonly wrapS?: number;
  readonly wrapT?: number;
  readonly name?: string;
}

export interface GltfTexture extends GltfProperty {
  readonly sampler?: number;
  readonly source?: number;
  readonly name?: string;
}

export interface GltfTextureInfo extends GltfProperty {
  readonly index: number;
  readonly texCoord?: number;
}

export interface GltfMaterial extends GltfProperty {
  readonly name?: string;
  readonly pbrMetallicRoughness?: GltfProperty & {
    readonly baseColorFactor?: readonly [number, number, number, number];
    readonly baseColorTexture?: GltfTextureInfo;
    readonly metallicFactor?: number;
    readonly roughnessFactor?: number;
    readonly metallicRoughnessTexture?: GltfTextureInfo;
  };
  readonly normalTexture?: GltfTextureInfo & { readonly scale?: number };
  readonly occlusionTexture?: GltfTextureInfo & { readonly strength?: number };
  readonly emissiveTexture?: GltfTextureInfo;
  readonly emissiveFactor?: readonly [number, number, number];
  readonly alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff?: number;
  readonly doubleSided?: boolean;
}

export interface GltfPrimitive extends GltfProperty {
  readonly attributes: Readonly<Record<string, number>>;
  readonly indices?: number;
  readonly material?: number;
  /** 0 points, 1 lines, 2 line loop, 3 line strip, 4 triangles (default), 5 triangle strip, 6 triangle fan. */
  readonly mode?: number;
  readonly targets?: readonly Readonly<Record<string, number>>[];
}

export interface GltfMesh extends GltfProperty {
  readonly primitives: readonly GltfPrimitive[];
  readonly weights?: readonly number[];
  readonly name?: string;
}

export interface GltfNode extends GltfProperty {
  readonly camera?: number;
  readonly children?: readonly number[];
  readonly skin?: number;
  /** Column-major. */
  readonly matrix?: readonly number[];
  readonly mesh?: number;
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
  readonly translation?: readonly [number, number, number];
  readonly weights?: readonly number[];
  readonly name?: string;
}

export interface GltfSkin extends GltfProperty {
  readonly inverseBindMatrices?: number;
  readonly skeleton?: number;
  readonly joints: readonly number[];
  readonly name?: string;
}

export interface GltfAnimation extends GltfProperty {
  readonly channels: readonly (GltfProperty & {
    readonly sampler: number;
    readonly target: GltfProperty & {
      readonly node?: number;
      readonly path: string;
    };
  })[];
  readonly samplers: readonly (GltfProperty & {
    readonly input: number;
    readonly output: number;
    readonly interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
  })[];
  readonly name?: string;
}

export interface GltfCamera extends GltfProperty {
  readonly type: 'perspective' | 'orthographic';
  readonly perspective?: {
    readonly yfov: number;
    readonly aspectRatio?: number;
    readonly znear: number;
    readonly zfar?: number;
  };
  readonly orthographic?: {
    readonly xmag: number;
    readonly ymag: number;
    readonly znear: number;
    readonly zfar: number;
  };
  readonly name?: string;
}

export interface GltfScene extends GltfProperty {
  readonly nodes?: readonly number[];
  readonly name?: string;
}

/** The root object of a glTF file. */
export interface GltfJson extends GltfProperty {
  readonly asset: GltfAsset;
  readonly extensionsUsed?: readonly string[];
  readonly extensionsRequired?: readonly string[];
  readonly accessors?: readonly GltfAccessor[];
  readonly animations?: readonly GltfAnimation[];
  readonly buffers?: readonly GltfBuffer[];
  readonly bufferViews?: readonly GltfBufferView[];
  readonly cameras?: readonly GltfCamera[];
  readonly images?: readonly GltfImage[];
  readonly materials?: readonly GltfMaterial[];
  readonly meshes?: readonly GltfMesh[];
  readonly nodes?: readonly GltfNode[];
  readonly samplers?: readonly GltfSampler[];
  readonly scene?: number;
  readonly scenes?: readonly GltfScene[];
  readonly skins?: readonly GltfSkin[];
  readonly textures?: readonly GltfTexture[];
}
