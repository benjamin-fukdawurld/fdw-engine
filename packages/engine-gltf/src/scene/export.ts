import {
  MaterialDataType,
  MeshDataType,
  type GraphMaterialData,
  type MaterialData,
  type MeshData,
  type PbrMaterialData,
  type TextureRef,
} from '@fdw/engine-assets';
import type {
  GpuSamplerConfiguration,
  ProjectionData,
} from '@fdw/engine-backend';
import type { PhysicsBodyData } from '@fdw/engine-physics';
import {
  defineResourceType,
  ResourceBytesType,
  type ResourceBytes,
  type ResourceLoader,
  type ResourceStore,
  type ResourceType,
} from '@fdw/engine-resources';
import {
  refUri,
  type CameraViewData,
  type ComponentData,
  type ExportedFile,
  type LightData,
  type MeshRendererData,
  type ResourceRef,
  type SceneData,
  type SceneExporter,
} from '@fdw/engine-scene-io';
import type { FdwGraphValue, FdwSceneMaterial } from '../extensions/fdwScene';
import { encodeGlb } from '../glb';
import type { FdwSceneNode } from './import';
import { encodeBinary } from './binary';
import { exportBody, type GltfImplicitShape } from './physics';

/** The bytes of a file, read as they are: the images written into a glTF. */
export const FileBytesType = defineResourceType<ResourceBytes>('file-bytes');

export const fileBytesLoader: ResourceLoader<ResourceBytes> = {
  type: FileBytesType,
  load: (ctx) => ctx.bytes(),
  sizeOf: (bytes) => bytes.byteLength,
};

export interface WriteGltfOptions {
  /** The store the resources of the scene are read from. */
  readonly store: ResourceStore;
  /** The URI the references of the scene are relative to (that of captureScene). */
  readonly uri?: string;
  /** A single `.glb` (the default), or a `.gltf` and its `.bin`. */
  readonly binary?: boolean;
  /** Receives what glTF cannot hold. console.warn by default. */
  readonly warn?: (message: string) => void;
}

type Json = Record<string, any>;
type Vec3 = readonly [number, number, number];

const semantics: Readonly<Record<string, [string, number]>> = {
  position: ['POSITION', 3],
  normal: ['NORMAL', 3],
  tangent: ['TANGENT', 4],
};

/** The glTF name and the components of an attribute of the engine. */
function gltfAttribute(semantic: string): [string, number] | undefined {
  if (semantics[semantic]) return semantics[semantic];
  const match = /^(uv|color|joints|weights)(\d*)$/.exec(semantic);
  if (!match) return undefined;
  const set = match[2] || '0';
  const [name, size] = {
    uv: ['TEXCOORD', 2],
    color: ['COLOR', 4],
    joints: ['JOINTS', 4],
    weights: ['WEIGHTS', 4],
  }[match[1]] as [string, number];
  return [`${name}_${set}`, size];
}

const readers: Readonly<
  Record<string, [number, (view: DataView, offset: number) => number, number]>
> = {
  // [bytes, read, divisor of the normalized ones]
  float32: [4, (v, o) => v.getFloat32(o, true), 1],
  float16: [2, (v, o) => halfToFloat(v.getUint16(o, true)), 1],
  uint32: [4, (v, o) => v.getUint32(o, true), 1],
  sint32: [4, (v, o) => v.getInt32(o, true), 1],
  uint16: [2, (v, o) => v.getUint16(o, true), 1],
  sint16: [2, (v, o) => v.getInt16(o, true), 1],
  unorm16: [2, (v, o) => v.getUint16(o, true), 65535],
  snorm16: [2, (v, o) => v.getInt16(o, true), 32767],
  uint8: [1, (v, o) => v.getUint8(o), 1],
  sint8: [1, (v, o) => v.getInt8(o), 1],
  unorm8: [1, (v, o) => v.getUint8(o), 255],
  snorm8: [1, (v, o) => v.getInt8(o), 127],
};

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * The attributes of a mesh of the engine, one tightly packed array each, in
 * the types glTF accepts: floats, the joints as unsigned shorts. An
 * attribute glTF has no name for is left out.
 */
export function meshAttributes(
  mesh: MeshData,
  warn: (message: string) => void,
): Map<string, { array: Float32Array | Uint16Array; components: number }> {
  const out = new Map<
    string,
    { array: Float32Array | Uint16Array; components: number }
  >();
  const count = mesh.description.vertexCount;
  mesh.description.vertexBuffers.forEach((buffer, b) => {
    if (buffer.stepMode === 'instance') return;
    const source = mesh.vertices[b];
    const view = new DataView(
      source.buffer,
      source.byteOffset,
      source.byteLength,
    );
    for (const attribute of buffer.attributes) {
      const gltf = gltfAttribute(attribute.semantic);
      if (!gltf) {
        warn(`attribute ${attribute.semantic} is not written`);
        continue;
      }
      const [name, wanted] = gltf;
      const match = /^([a-z]+\d+)(?:x(\d))?$/.exec(attribute.format)!;
      const [size, read, divisor] = readers[match[1]];
      const components = Number(match[2] ?? 1);
      const kept = name.startsWith('COLOR')
        ? Math.min(components, 4)
        : Math.min(components, wanted);
      const joints = name.startsWith('JOINTS');
      const array = joints
        ? new Uint16Array(count * wanted)
        : new Float32Array(count * kept);
      const width = joints ? wanted : kept;
      for (let v = 0; v < count; v++) {
        const base = v * buffer.stride + attribute.offset;
        for (let c = 0; c < Math.min(components, width); c++) {
          const value = read(view, base + c * size);
          array[v * width + c] =
            divisor === 1 ? value : Math.max(value / divisor, -1);
        }
      }
      out.set(name, { array, components: width });
    }
  });
  return out;
}

const modes: Readonly<Record<string, number>> = {
  'point-list': 0,
  'line-list': 1,
  'line-strip': 3,
  'triangle-list': 4,
  'triangle-strip': 5,
};

const wrapCodes: Readonly<Record<string, number>> = {
  'clamp-to-edge': 33071,
  'mirror-repeat': 33648,
  repeat: 10497,
};

/** A sampler of glTF from a configuration of the engine. */
export function gltfSampler(config: GpuSamplerConfiguration): Json {
  const linear = (f: string | undefined) => (f ?? 'linear') === 'linear';
  const min = linear(config.minFilter);
  const minFilter =
    config.mipmapFilter === undefined
      ? min
        ? 9729
        : 9728
      : 9984 + (min ? 1 : 0) + (linear(config.mipmapFilter) ? 2 : 0);
  return {
    magFilter: linear(config.magFilter) ? 9729 : 9728,
    minFilter,
    wrapS: wrapCodes[config.wrapModeS ?? 'repeat'] ?? 10497,
    wrapT: wrapCodes[config.wrapModeT ?? 'repeat'] ?? 10497,
  };
}

/** The type of an image by its first bytes. */
export function imageType(bytes: Uint8Array): string | undefined {
  const at = (offset: number, text: string) =>
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0xab && at(1, 'KTX 20')) return 'image/ktx2';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return undefined;
}

const lossless = (light: LightData): boolean => {
  const same = (a: Vec3, b: Vec3) => a.every((v, i) => v === b[i]);
  return (
    same(light.ambient, [0, 0, 0]) &&
    same(light.diffuse, light.specular) &&
    (light.type === 'directional' ||
      same(light.attenuation ?? [1, 0, 0], [1, 0, 1])) &&
    !light.castShadow &&
    !light.shadow
  );
};

/**
 * Writes a scene as glTF 2.0: its nodes, meshes, materials and textures
 * (the images as they are, not encoded again), lights
 * (`KHR_lights_punctual`), cameras, physics bodies
 * (`KHR_physics_rigid_bodies`, `KHR_implicit_shapes`), batches
 * (`EXT_mesh_gpu_instancing`), and in `FDW_scene` what glTF has no place
 * for: the engine reads the file back as it was written. Instances of
 * models are not written: capture with `instances: 'expand'`.
 */
export async function writeGltf(
  data: SceneData,
  path: string,
  options: WriteGltfOptions,
): Promise<ExportedFile[]> {
  const writer = new GltfWriter(data, options);
  return writer.write(path);
}

class GltfWriter {
  private readonly json: Json = {
    asset: { version: '2.0', generator: 'FdwEngine' },
  };
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  private readonly used = new Set<string>();
  private readonly required = new Set<string>();
  private readonly warn: (message: string) => void;
  private readonly meshes = new Map<string, Json>();
  private readonly meshNames = new Map<Json, string>();
  private readonly pairs = new Map<string, number>();
  private readonly materials = new Map<string, number>();
  private readonly images = new Map<string, Promise<number>>();
  private readonly samplers = new Map<string, number>();
  private readonly textures = new Map<string, number>();
  private readonly shapes = new Map<string, number>();
  private readonly physicsMaterials = new Map<string, number>();
  private readonly filters = new Map<string, number>();
  private readonly lights: Json[] = [];

  constructor(
    private readonly data: SceneData,
    private readonly options: WriteGltfOptions,
  ) {
    this.warn = options.warn ?? ((m) => console.warn(`[gltf] ${m}`));
  }

  private list(name: string): Json[] {
    return (this.json[name] ??= []);
  }

  private add(name: string, item: Json): number {
    return this.list(name).push(item) - 1;
  }

  private view(bytes: ArrayBufferView, target?: number): number {
    const padding = (4 - (this.length % 4)) % 4;
    if (padding) this.chunks.push(new Uint8Array(padding));
    this.length += padding;
    const byteOffset = this.length;
    this.chunks.push(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    this.length += bytes.byteLength;
    return this.add('bufferViews', {
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
  }

  private accessor(
    array: Float32Array | Uint16Array | Uint32Array,
    type: string,
    components: number,
    extra: Json = {},
    target?: number,
  ): number {
    const componentType =
      array instanceof Float32Array
        ? 5126
        : array instanceof Uint16Array
          ? 5123
          : 5125;
    return this.add('accessors', {
      bufferView: this.view(array, target),
      componentType,
      count: array.length / components,
      type,
      ...extra,
    });
  }

  private binary<T>(value: T): T {
    return encodeBinary(value, (bytes) => this.view(bytes)) as T;
  }

  private resolve(ref: ResourceRef): string {
    const uri = refUri(ref);
    return this.options.uri !== undefined
      ? this.options.store.resolve(this.options.uri, uri)
      : uri;
  }

  // A value of the store: the one there, or loaded for the export.
  private async fromStore<T>(type: ResourceType<T>, uri: string): Promise<T> {
    const { store } = this.options;
    const peeked = store.peek(type, uri);
    const handle = peeked ?? store.load(type, uri);
    try {
      return await handle.ready;
    } finally {
      handle.release();
    }
  }

  private local<T>(ref: ResourceRef, kind: string, list: readonly T[]) {
    const match = new RegExp(`^#${kind}/(\\d+)$`).exec(refUri(ref));
    return match ? list[Number(match[1])] : undefined;
  }

  // --- Images, textures, materials ------------------------------------------------

  private image(uri: string): Promise<number> {
    let promise = this.images.get(uri);
    if (!promise) {
      promise = (async () => {
        const { store } = this.options;
        const provided = store.peek(ResourceBytesType, uri);
        let bytes: ResourceBytes;
        if (provided) {
          bytes = await provided.ready;
          provided.release();
        } else {
          bytes = await this.fromStore(FileBytesType, uri);
        }
        const mimeType = imageType(bytes);
        if (!mimeType) this.warn(`${uri}: unknown image type`);
        return this.add('images', {
          bufferView: this.view(bytes),
          mimeType: mimeType ?? 'application/octet-stream',
        });
      })();
      this.images.set(uri, promise);
    }
    return promise;
  }

  private async texture(
    uri: string,
    sampler: GpuSamplerConfiguration | undefined,
  ): Promise<number> {
    const image = await this.image(uri);
    const mimeType = this.json['images'][image].mimeType as string;
    const samplerJson = gltfSampler(sampler ?? {});
    const samplerKey = JSON.stringify(samplerJson);
    let samplerIndex = this.samplers.get(samplerKey);
    if (samplerIndex === undefined) {
      samplerIndex = this.add('samplers', samplerJson);
      this.samplers.set(samplerKey, samplerIndex);
    }
    const key = `${image}|${samplerIndex}`;
    let index = this.textures.get(key);
    if (index === undefined) {
      const special =
        mimeType === 'image/ktx2'
          ? 'KHR_texture_basisu'
          : mimeType === 'image/webp'
            ? 'EXT_texture_webp'
            : undefined;
      if (special) {
        this.used.add(special);
        this.required.add(special);
      }
      index = this.add('textures', {
        sampler: samplerIndex,
        ...(special
          ? { extensions: { [special]: { source: image } } }
          : { source: image }),
      });
      this.textures.set(key, index);
    }
    return index;
  }

  private async textureInfo(
    ref: TextureRef | undefined,
  ): Promise<Json | undefined> {
    if (!ref) return undefined;
    const index = await this.texture(ref.image, ref.sampler);
    const transform = ref.transform;
    if (transform) this.used.add('KHR_texture_transform');
    return {
      index,
      ...(ref.texCoord ? { texCoord: ref.texCoord } : {}),
      ...(transform
        ? {
            extensions: {
              KHR_texture_transform: {
                offset: transform.offset,
                rotation: transform.rotation,
                scale: transform.scale,
              },
            },
          }
        : {}),
    };
  }

  private async pbr(material: PbrMaterialData): Promise<Json> {
    const [base, mr, normal, occlusion, emissive] = await Promise.all([
      this.textureInfo(material.baseColorTexture),
      this.textureInfo(material.metallicRoughnessTexture),
      this.textureInfo(material.normalTexture),
      this.textureInfo(material.occlusionTexture),
      this.textureInfo(material.emissiveTexture),
    ]);
    const strength = Math.max(...material.emissive, 1);
    const extensions: Json = {};
    if (strength > 1) {
      extensions['KHR_materials_emissive_strength'] = {
        emissiveStrength: strength,
      };
      this.used.add('KHR_materials_emissive_strength');
    }
    if (material.unlit) {
      extensions['KHR_materials_unlit'] = {};
      this.used.add('KHR_materials_unlit');
    }
    return {
      ...(material.name !== undefined ? { name: material.name } : {}),
      pbrMetallicRoughness: {
        baseColorFactor: [...material.baseColor],
        ...(base ? { baseColorTexture: base } : {}),
        metallicFactor: material.metallic,
        roughnessFactor: material.roughness,
        ...(mr ? { metallicRoughnessTexture: mr } : {}),
      },
      ...(normal
        ? {
            normalTexture: {
              ...normal,
              scale: material.normalTexture!.scale,
            },
          }
        : {}),
      ...(occlusion
        ? {
            occlusionTexture: {
              ...occlusion,
              strength: material.occlusionTexture!.strength,
            },
          }
        : {}),
      emissiveFactor: material.emissive.map((e) => e / strength),
      ...(emissive ? { emissiveTexture: emissive } : {}),
      alphaMode: material.alphaMode.toUpperCase(),
      ...(material.alphaMode === 'mask'
        ? { alphaCutoff: material.alphaCutoff }
        : {}),
      doubleSided: material.doubleSided,
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    };
  }

  private async graph(material: GraphMaterialData): Promise<Json> {
    const values: Record<string, FdwGraphValue> = {};
    let preview: number | undefined;
    for (const [name, value] of Object.entries(material.values)) {
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'texture' in value
      ) {
        const { texture, ...options } = value as {
          texture: string;
          colorSpace?: 'srgb' | 'linear';
          mips?: 'generate' | 'none' | 'file';
        };
        let image: number;
        try {
          image = await this.image(this.resolve(texture));
        } catch (e) {
          // A texture made by code (a baked one): no file to copy.
          this.warn(`${texture}: not written (${(e as Error).message})`);
          this.images.delete(this.resolve(texture));
          values[name] = value as FdwGraphValue;
          continue;
        }
        values[name] = { image, ...options };
        // The first color texture shows the material in other tools.
        if (preview === undefined && options.colorSpace !== 'linear')
          preview = await this.texture(this.resolve(texture), undefined);
      } else {
        values[name] = value as FdwGraphValue;
      }
    }
    const fdw: FdwSceneMaterial = { material: { ...material, values } };
    this.used.add('FDW_scene');
    const state = material.renderState;
    return {
      ...(material.name !== undefined ? { name: material.name } : {}),
      pbrMetallicRoughness: {
        metallicFactor: 0,
        roughnessFactor: 1,
        ...(preview !== undefined
          ? { baseColorTexture: { index: preview } }
          : {}),
      },
      ...(state?.alphaMode && state.alphaMode !== 'opaque'
        ? { alphaMode: state.alphaMode.toUpperCase() }
        : {}),
      ...(state?.doubleSided ? { doubleSided: true } : {}),
      extensions: { FDW_scene: fdw },
    };
  }

  private async materialJson(material: MaterialData): Promise<Json> {
    switch (material.kind) {
      case 'pbr':
        return this.pbr(material);
      case 'graph':
        return this.graph(material);
      case 'phong': {
        // Diffuse and specular to metal and roughness, roughly: a
        // dielectric, its roughness from the shininess.
        const pbr: PbrMaterialData = {
          kind: 'pbr',
          name: material.name,
          baseColor: [...material.diffuse, material.opacity],
          baseColorTexture: material.diffuseTexture,
          metallic: 0,
          roughness: Math.min(Math.sqrt(2 / (material.shininess + 2)), 1),
          normalTexture: material.normalTexture && {
            ...material.normalTexture,
            scale: 1,
          },
          emissive: material.emissive,
          emissiveTexture: material.emissiveTexture,
          alphaMode: material.alphaMode,
          alphaCutoff: 0.5,
          doubleSided: material.doubleSided,
        };
        return this.pbr(pbr);
      }
    }
  }

  private async material(ref: ResourceRef): Promise<number> {
    const uri = this.resolve(ref);
    let index = this.materials.get(uri);
    if (index === undefined) {
      const material =
        this.local(ref, 'material', this.data.materials) ??
        (await this.fromStore(MaterialDataType, uri));
      index = this.add('materials', await this.materialJson(material));
      this.materials.set(uri, index);
    }
    return index;
  }

  // --- Meshes ------------------------------------------------------------------------

  private async geometry(ref: ResourceRef): Promise<Json> {
    const uri = this.resolve(ref);
    let primitive = this.meshes.get(uri);
    if (!primitive) {
      const mesh =
        this.local(ref, 'mesh', this.data.meshes) ??
        (await this.fromStore(MeshDataType, uri));
      const mode = modes[mesh.description.topology ?? 'triangle-list'] ?? 4;
      const attributes: Json = {};
      for (const [name, { array, components }] of meshAttributes(mesh, (m) =>
        this.warn(`mesh ${uri}: ${m}`),
      )) {
        const type = components === 1 ? 'SCALAR' : `VEC${components}`;
        let extra: Json = {};
        if (name === 'POSITION') {
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < array.length; i++) {
            min[i % 3] = Math.min(min[i % 3], array[i]);
            max[i % 3] = Math.max(max[i % 3], array[i]);
          }
          extra = { min, max };
        }
        attributes[name] = this.accessor(array, type, components, extra, 34962);
      }
      const indices = mesh.indices
        ? this.accessor(
            mesh.indices instanceof Uint16Array
              ? mesh.indices
              : Uint32Array.from(mesh.indices),
            'SCALAR',
            1,
            {},
            34963,
          )
        : undefined;
      primitive = {
        attributes,
        ...(indices !== undefined ? { indices } : {}),
        ...(mode !== 4 ? { mode } : {}),
      };
      this.meshes.set(uri, primitive);
      if (mesh.name !== undefined) this.meshNames.set(primitive, mesh.name);
    }
    return primitive;
  }

  /** The glTF mesh drawing a mesh with a material, one per pair. */
  private async mesh(renderer: MeshRendererData): Promise<number> {
    const [primitive, material] = await Promise.all([
      this.geometry(renderer.mesh),
      this.material(renderer.material),
    ]);
    const key = `${this.resolve(renderer.mesh)}|${material}`;
    let index = this.pairs.get(key);
    if (index === undefined) {
      const name = this.meshNames.get(primitive);
      index = this.add('meshes', {
        ...(name !== undefined ? { name } : {}),
        primitives: [{ ...primitive, material }],
      });
      this.pairs.set(key, index);
    }
    return index;
  }

  private colliderMesh(vertices: Float32Array, indices?: Uint32Array): number {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i++) {
      min[i % 3] = Math.min(min[i % 3], vertices[i]);
      max[i % 3] = Math.max(max[i % 3], vertices[i]);
    }
    const position = this.accessor(
      Float32Array.from(vertices),
      'VEC3',
      3,
      { min, max },
      34962,
    );
    return this.add('meshes', {
      name: 'collider',
      primitives: [
        {
          attributes: { POSITION: position },
          ...(indices
            ? {
                indices: this.accessor(
                  Uint32Array.from(indices),
                  'SCALAR',
                  1,
                  {},
                  34963,
                ),
              }
            : { mode: 0 }),
        },
      ],
    });
  }

  // --- Nodes ---------------------------------------------------------------------------

  private shared<T>(map: Map<string, number>, list: string, item: T): number {
    const key = JSON.stringify(item);
    let index = map.get(key);
    if (index === undefined) {
      const root = (this.json['extensions'] ??= {});
      const owner =
        list === 'shapes'
          ? (root['KHR_implicit_shapes'] ??= { shapes: [] })
          : (root['KHR_physics_rigid_bodies'] ??= {});
      index = (owner[list] ??= []).push(item) - 1;
      map.set(key, index!);
    }
    return index!;
  }

  private light(light: LightData): number {
    const max = Math.max(...light.diffuse);
    const color = max > 0 ? light.diffuse.map((c) => c / max) : [1, 1, 1];
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    this.used.add('KHR_lights_punctual');
    return (
      this.lights.push({
        type: light.type,
        color,
        intensity: max,
        ...(light.type === 'spot'
          ? {
              spot: {
                innerConeAngle: radians(light.innerCutoff ?? 0),
                outerConeAngle: radians(light.outerCutoff ?? 45),
              },
            }
          : {}),
      }) - 1
    );
  }

  private camera(projection: ProjectionData): [number, boolean] {
    if (projection.type === 'perspective') {
      return [
        this.add('cameras', {
          type: 'perspective',
          perspective: {
            yfov: (projection.fov * Math.PI) / 180,
            aspectRatio: projection.aspect,
            znear: projection.near,
            zfar: projection.far,
          },
        }),
        true,
      ];
    }
    const { left, right, bottom, top, near, far } = projection;
    return [
      this.add('cameras', {
        type: 'orthographic',
        orthographic: {
          xmag: (right - left) / 2,
          ymag: (top - bottom) / 2,
          znear: near,
          zfar: far,
        },
      }),
      left === -right && bottom === -top,
    ];
  }

  async write(path: string): Promise<ExportedFile[]> {
    const { data } = this;
    const nodes: Json[] = data.nodes.map(() => ({}));
    const roots: number[] = [];
    const childrenOf = (parent: number | undefined, child: number) => {
      if (parent === undefined) roots.push(child);
      else (nodes[parent]['children'] ??= []).push(child);
    };
    const pending: { parent: number; json: Json }[] = [];

    for (let i = 0; i < data.nodes.length; i++) {
      const node = data.nodes[i];
      const out = nodes[i];
      if (node.name !== undefined) out['name'] = node.name;
      if (node.position) out['translation'] = [...node.position];
      if (node.rotation) out['rotation'] = [...node.rotation];
      if (node.scale) out['scale'] = [...node.scale];
      if (node.instance)
        this.warn(
          `node ${node.name ?? i}: an instance is not written (capture with instances: 'expand')`,
        );
      if (node.parentPath !== undefined)
        this.warn(`node ${node.name ?? i}: placed under its instance's root`);
      childrenOf(node.parent, i);

      const fdw: { -readonly [K in keyof FdwSceneNode]: FdwSceneNode[K] } = {};
      const extensions: Json = {};
      const components: Record<string, ComponentData> = {};
      for (const [name, component] of Object.entries(node.components ?? {})) {
        if (component.version !== 1) {
          components[name] = component;
          continue;
        }
        switch (name) {
          case 'mesh renderer': {
            const renderer = component.data as MeshRendererData;
            out['mesh'] = await this.mesh(renderer);
            if (renderer.castShadow === false) fdw.castShadow = false;
            break;
          }
          case 'light': {
            const light = component.data as LightData;
            extensions['KHR_lights_punctual'] = { light: this.light(light) };
            if (!lossless(light)) components[name] = component;
            break;
          }
          case 'camera view': {
            const [camera, exact] = this.camera(
              (component.data as CameraViewData).projection,
            );
            out['camera'] = camera;
            if (!exact) components[name] = component;
            break;
          }
          case 'physics body': {
            const body = exportBody(component.data as PhysicsBodyData, {
              shape: (shape: GltfImplicitShape) =>
                this.shared(this.shapes, 'shapes', shape),
              mesh: (vertices, indices) => this.colliderMesh(vertices, indices),
              material: (material) =>
                this.shared(
                  this.physicsMaterials,
                  'physicsMaterials',
                  material,
                ),
              filter: (filter) =>
                this.shared(this.filters, 'collisionFilters', filter),
              warn: (m) => this.warn(`node ${node.name ?? i}: ${m}`),
            });
            this.used.add('KHR_physics_rigid_bodies');
            if (Object.keys(body.node).length > 0)
              extensions['KHR_physics_rigid_bodies'] = body.node;
            for (const helper of body.helpers) {
              if (
                helper.physics.collider?.geometry?.shape !== undefined ||
                helper.physics.trigger?.geometry?.shape !== undefined
              )
                this.used.add('KHR_implicit_shapes');
              pending.push({
                parent: i,
                json: {
                  name: `${node.name ?? `node ${i}`}#collider`,
                  ...(helper.translation
                    ? { translation: helper.translation }
                    : {}),
                  ...(helper.rotation ? { rotation: helper.rotation } : {}),
                  extensions: {
                    KHR_physics_rigid_bodies: helper.physics,
                    FDW_scene: { helper: true },
                  },
                },
              });
            }
            if (this.shapes.size > 0) this.used.add('KHR_implicit_shapes');
            // The engine reads its own description: exact.
            components[name] = component;
            break;
          }
          default:
            components[name] = component;
        }
      }
      const fields = {
        ...(node.visible === false ? { visible: false } : {}),
        ...(node.static ? { static: true } : {}),
        ...(node.occluder ? { occluder: true } : {}),
        ...(node.layers !== undefined ? { layers: node.layers } : {}),
      };
      if (Object.keys(fields).length > 0) fdw.node = fields;
      if (Object.keys(components).length > 0)
        fdw.components = this.binary(components);
      if (Object.keys(fdw).length > 0) {
        extensions['FDW_scene'] = fdw;
        this.used.add('FDW_scene');
      }
      if (Object.keys(extensions).length > 0) out['extensions'] = extensions;
    }

    // The helpers of the colliders, then the batches: after the nodes, whose
    // indices stay those of the scene.
    for (const { parent, json } of pending) {
      const index = nodes.push(json) - 1;
      childrenOf(parent, index);
    }
    for (const batch of data.batches) {
      const attributes = {
        TRANSLATION: this.accessor(batch.positions, 'VEC3', 3),
        ROTATION: this.accessor(batch.rotations, 'VEC4', 4),
        SCALE: this.accessor(batch.scales, 'VEC3', 3),
      };
      const mesh =
        batch.mesh !== undefined && batch.material !== undefined
          ? await this.mesh({ mesh: batch.mesh, material: batch.material })
          : undefined;
      const fdw: FdwSceneNode = {
        batch: {
          count: batch.count,
          ...(batch.visible === false ? { visible: false } : {}),
          ...(batch.static ? { static: true } : {}),
          ...(batch.occluder ? { occluder: true } : {}),
          ...(batch.layers !== undefined ? { layers: batch.layers } : {}),
          ...(batch.castShadow === false ? { castShadow: false } : {}),
          ...(mesh === undefined ? { attributes } : {}),
          ...(batch.components
            ? { components: this.binary(batch.components) }
            : {}),
        },
      };
      this.used.add('FDW_scene');
      if (mesh !== undefined) this.used.add('EXT_mesh_gpu_instancing');
      const index =
        nodes.push({
          ...(batch.name !== undefined ? { name: batch.name } : {}),
          ...(mesh !== undefined ? { mesh } : {}),
          extensions: {
            ...(mesh !== undefined
              ? { EXT_mesh_gpu_instancing: { attributes } }
              : {}),
            FDW_scene: fdw,
          },
        }) - 1;
      childrenOf(batch.parent, index);
    }

    const json = this.json;
    if (nodes.length > 0) json['nodes'] = nodes;
    json['scenes'] = [
      { ...(data.name ? { name: data.name } : {}), nodes: roots },
    ];
    json['scene'] = 0;
    if (this.lights.length > 0) {
      json['extensions'] = {
        ...json['extensions'],
        KHR_lights_punctual: { lights: this.lights },
      };
    }
    if (this.used.size > 0) json['extensionsUsed'] = [...this.used].sort();
    if (this.required.size > 0)
      json['extensionsRequired'] = [...this.required].sort();

    const bin = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      bin.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const binary = this.options.binary ?? true;
    if (binary) {
      if (bin.byteLength > 0)
        json['buffers'] = [{ byteLength: bin.byteLength }];
      return [
        { path, bytes: encodeGlb(json, bin.byteLength > 0 ? bin : undefined) },
      ];
    }
    const binPath = path.replace(/\.gltf$/i, '') + '.bin';
    const files: ExportedFile[] = [];
    if (bin.byteLength > 0) {
      json['buffers'] = [
        {
          uri: encodeURI(binPath.slice(binPath.lastIndexOf('/') + 1)),
          byteLength: bin.byteLength,
        },
      ];
    }
    files.push({
      path,
      bytes: new TextEncoder().encode(JSON.stringify(json, null, 2)),
    });
    if (bin.byteLength > 0) files.push({ path: binPath, bytes: bin });
    return files;
  }
}

/** The exporter of glTF: `writeGltf`, a `.glb` by default. */
export const gltfSceneExporter: SceneExporter<WriteGltfOptions> = {
  format: 'gltf',
  extensions: ['glb', 'gltf'],
  write: (data, path, options) => {
    if (!options) throw new Error('The glTF exporter needs a store');
    return writeGltf(data, path, {
      ...options,
      binary: options.binary ?? !/\.gltf$/i.test(path),
    });
  },
};
