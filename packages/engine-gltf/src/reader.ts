import {
  defaultPbrMaterial,
  MaterialDataType,
  MeshDataType,
  type MeshData,
  type ModelData,
  type ModelMeshData,
  type PbrMaterialData,
  type PrimitiveData,
  type TextureRef,
} from '@fdw/engine-assets';
import {
  ResourceBytesType,
  ResourceError,
  type LoadContext,
  type ResourceBytes,
  type ResourceUri,
} from '@fdw/engine-resources';
import { accessorReader } from './accessors';
import { BufferType } from './buffers';
import type {
  GltfAttributeData,
  GltfContext,
  GltfDecodedPrimitive,
  GltfExtension,
} from './extension';
import { GltfMode, primitiveMeshData } from './geometry';
import { decodeDataUri } from './glb';
import { pbrMaterialData, samplerConfiguration } from './materials';
import {
  animationData,
  cameraData,
  nodeData,
  rootNodes,
  skinData,
} from './nodes';
import type { GltfConfig } from './options';
import type {
  GltfJson,
  GltfPrimitive,
  GltfProperty,
  GltfTextureInfo,
} from './types';

type Hook = Exclude<keyof GltfExtension, 'name' | 'prepare'>;

// The primitives drawn: triangles, strips and fans.
const drawn = (primitive: GltfPrimitive): boolean => {
  const mode = primitive.mode ?? GltfMode.TRIANGLES;
  return mode >= GltfMode.TRIANGLES && mode <= GltfMode.TRIANGLE_FAN;
};

const modeNames: Readonly<Record<number, string>> = {
  0: 'points',
  1: 'lines',
  2: 'a line loop',
  3: 'a line strip',
};

// The URIs of glTF are percent-encoded (`my%20texture.png`); the sources
// take plain paths.
const decodeUri = (uri: string): string => {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
};

/**
 * The keys of the sub-resources of a list (meshes, materials): the name when
 * it is unique, else the index. `/` and `#` would split the URI, so they
 * become `_`; a name that looks like an index, or a reserved one
 * (`default`), takes the index too.
 */
export function subResourceKeys(
  items: readonly { readonly name?: string }[],
  reserved: ReadonlySet<string> = new Set()
): string[] {
  const names = items.map((item) =>
    item.name ? item.name.replace(/[/#]/g, '_') : undefined
  );
  const counts = new Map<string, number>();
  for (const name of names)
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  return names.map((name, i) =>
    name && counts.get(name) === 1 && !/^\d+$/.test(name) && !reserved.has(name)
      ? name
      : String(i)
  );
}

/** `models/oak.glb` → `oak`. */
export function modelName(uri: ResourceUri): string {
  const path = uri.split('#', 1)[0];
  const file = path.slice(
    Math.max(path.lastIndexOf('/'), path.lastIndexOf(':')) + 1
  );
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

const memoize = <T>(read: (index: number) => Promise<T>) => {
  const cache = new Map<number, Promise<T>>();
  return (index: number): Promise<T> => {
    let promise = cache.get(index);
    if (!promise) cache.set(index, (promise = read(index)));
    return promise;
  };
};

/**
 * One load of a glTF file: its buffers, images and accessors read once
 * each, its meshes and materials provided as sub-resources of its URI, its
 * extensions applied.
 */
export class GltfReader {
  readonly context: GltfContext;
  private readonly active = new Map<string, GltfExtension>();
  private readonly accessor: (index: number) => Promise<GltfAttributeData>;

  constructor(
    private readonly ctx: LoadContext<unknown>,
    private readonly json: GltfJson,
    private readonly bin: Uint8Array<ArrayBuffer> | undefined,
    private readonly config: GltfConfig,
    warn: (message: string) => void
  ) {
    this.context = {
      uri: ctx.uri,
      json,
      signal: ctx.signal,
      options: config.options,
      warn,
      buffer: memoize((index) => this.readBuffer(index)),
      bufferView: memoize((index) => this.readBufferView(index)),
    };
    this.accessor = accessorReader(json, this.context.bufferView);
  }

  /**
   * Selects the extensions of the file. A required one that is unknown, or
   * whose decoder is missing, fails the load with its name; an optional one
   * is ignored with a warning.
   */
  async prepare(): Promise<void> {
    const required = new Set(this.json.extensionsRequired ?? []);
    for (const name of new Set([
      ...(this.json.extensionsUsed ?? []),
      ...required,
    ])) {
      const extension = this.config.extensions.get(name);
      if (extension && (await (extension.prepare?.(this.context) ?? true))) {
        this.active.set(name, extension);
        continue;
      }
      const why = extension
        ? 'needs a decoder, missing from the options of installGltf'
        : 'is not supported';
      if (required.has(name)) {
        throw new ResourceError(
          'unsupported',
          this.ctx.uri,
          `${this.ctx.uri}: the required glTF extension ${name} ${why}`
        );
      }
      this.context.warn(
        `${this.ctx.uri}: the glTF extension ${name} ${why}; ignored`
      );
    }
  }

  // The active extensions of an object that have a hook, with their JSON.
  private hooks<K extends Hook>(
    owner: GltfProperty | undefined,
    hook: K
  ): [unknown, Required<Pick<GltfExtension, K>>][] {
    return Object.entries(owner?.extensions ?? {}).flatMap(([name, ext]) => {
      const extension = this.active.get(name);
      return extension?.[hook]
        ? [[ext, extension as unknown as Required<Pick<GltfExtension, K>>]]
        : [];
    });
  }

  private async readBuffer(index: number): Promise<Uint8Array<ArrayBuffer>> {
    const buffer = this.json.buffers?.[index];
    if (!buffer) throw new Error(`Missing buffer ${index}`);
    if (buffer.uri === undefined) {
      if (index === 0 && this.bin) return this.bin;
      throw new Error(`Buffer ${index} has no data`);
    }
    // An external file is a dependency: shared, cancelled with this load.
    return (
      decodeDataUri(buffer.uri) ??
      this.ctx.use(BufferType, this.ctx.resolve(decodeUri(buffer.uri))).ready
    );
  }

  private async readBufferView(
    index: number
  ): Promise<Uint8Array<ArrayBuffer>> {
    const view = this.json.bufferViews?.[index];
    if (!view) throw new Error(`Missing buffer view ${index}`);
    const [decoder] = this.hooks(view, 'bufferView');
    if (decoder) return decoder[1].bufferView(decoder[0], view, this.context);
    const bytes = await this.context.buffer(view.buffer);
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > bytes.byteLength)
      throw new Error(`Buffer view ${index} out of its buffer`);
    return bytes.subarray(start, start + view.byteLength);
  }

  /**
   * The URI of an image: its file, or `model.glb#image/<i>` for the images
   * held by a buffer view or a data URI, whose bytes are provided as a
   * sub-resource (a copy: it does not keep the whole file alive).
   */
  private readonly image = memoize(
    async (index: number): Promise<ResourceUri> => {
      const image = this.json.images?.[index];
      if (!image) throw new Error(`Missing image ${index}`);
      let bytes: ResourceBytes | undefined;
      if (image.uri !== undefined) {
        bytes = decodeDataUri(image.uri);
        if (!bytes) return this.ctx.resolve(decodeUri(image.uri));
      } else if (image.bufferView !== undefined) {
        bytes = (await this.context.bufferView(image.bufferView)).slice();
      } else {
        throw new Error(`Image ${index} has neither uri nor bufferView`);
      }
      this.ctx.provide(ResourceBytesType, `image/${index}`, bytes);
      return this.ctx.resolve(`#image/${index}`);
    }
  );

  private async textureRef(
    info: GltfTextureInfo
  ): Promise<TextureRef | undefined> {
    const texture = this.json.textures?.[info.index];
    if (!texture) throw new Error(`Missing texture ${info.index}`);
    let source = texture.source;
    for (const [ext, extension] of this.hooks(texture, 'textureSource')) {
      source = extension.textureSource(ext, texture, this.context) ?? source;
    }
    if (source === undefined) {
      this.context.warn(
        `${this.ctx.uri}: texture ${info.index} has no image the loader can read; left out`
      );
      return undefined;
    }
    const sampler =
      texture.sampler !== undefined
        ? this.json.samplers?.[texture.sampler]
        : undefined;
    let ref: TextureRef = {
      image: await this.image(source),
      texCoord: info.texCoord ?? 0,
      sampler: samplerConfiguration(sampler),
    };
    for (const [ext, extension] of this.hooks(info, 'textureInfo'))
      ref = extension.textureInfo(ext, ref, this.context, info);
    return ref;
  }

  /**
   * Provides a `PbrMaterialData` per material, `material/<name or index>`,
   * and `material/default` when a primitive has none. A material of a
   * primitive with vertex colors multiplies by them.
   */
  private async readMaterials(): Promise<{
    ids: string[];
    materials: PbrMaterialData[];
    fallback?: PbrMaterialData;
  }> {
    const primitives = (this.json.meshes ?? [])
      .flatMap((m) => m.primitives)
      .filter(drawn);
    const colored = new Set(
      primitives
        .filter((p) => p.attributes['COLOR_0'] !== undefined)
        .map((p) => p.material ?? -1)
    );
    const gltfMaterials = this.json.materials ?? [];
    const keys = subResourceKeys(gltfMaterials, new Set(['default']));
    const materials = await Promise.all(
      gltfMaterials.map(async (material, i) => {
        let data = await pbrMaterialData(
          material,
          (info) => this.textureRef(info),
          colored.has(i)
        );
        for (const [ext, extension] of this.hooks(material, 'material'))
          data = extension.material(ext, data, this.context, material);
        this.ctx.provide(MaterialDataType, `material/${keys[i]}`, data);
        return data;
      })
    );
    let fallback: PbrMaterialData | undefined;
    if (primitives.some((p) => p.material === undefined)) {
      fallback = colored.has(-1)
        ? { ...defaultPbrMaterial, vertexColors: true }
        : defaultPbrMaterial;
      this.ctx.provide(MaterialDataType, 'material/default', fallback);
    }
    return { ids: keys.map((key) => `material/${key}`), materials, fallback };
  }

  private async primitiveData(
    primitive: GltfPrimitive,
    name: string | undefined,
    normals: boolean
  ): Promise<MeshData> {
    let decoded: GltfDecodedPrimitive | undefined;
    const [decoder] = this.hooks(primitive, 'primitive');
    if (decoder)
      decoded = await decoder[1].primitive(decoder[0], primitive, this.context);
    const entries = await Promise.all(
      Object.entries(primitive.attributes).map(
        async ([attribute, index]) =>
          [
            attribute,
            decoded?.attributes[attribute] ?? (await this.accessor(index)),
          ] as const
      )
    );
    let indices: ArrayLike<number> | undefined = decoded?.indices;
    if (!indices && primitive.indices !== undefined) {
      const data = await this.accessor(primitive.indices);
      if (data.components !== 1 || data.array instanceof Float32Array)
        throw new Error('Indices must be unsigned scalars');
      indices = data.array;
    }
    return primitiveMeshData({
      name,
      attributes: new Map(entries),
      indices,
      mode: primitive.mode ?? GltfMode.TRIANGLES,
      normals,
    });
  }

  /** Provides a `MeshData` per drawn primitive, `mesh/<name or index>/<primitive>`. */
  private async readMeshes(
    materials: Awaited<ReturnType<GltfReader['readMaterials']>>
  ): Promise<ModelMeshData[]> {
    const meshes = this.json.meshes ?? [];
    const keys = subResourceKeys(meshes);
    return Promise.all(
      meshes.map(async (mesh, m) => {
        if (mesh.primitives.some((p) => p.targets?.length)) {
          this.context.warn(
            `${this.ctx.uri}: the morph targets of mesh ${keys[m]} are not read`
          );
        }
        const primitives = await Promise.all(
          mesh.primitives.map(
            async (primitive, i): Promise<PrimitiveData | undefined> => {
              if (!drawn(primitive)) {
                const mode =
                  modeNames[primitive.mode!] ?? `mode ${primitive.mode}`;
                this.context.warn(
                  `${this.ctx.uri}: primitive ${i} of mesh ${keys[m]} skipped: ${mode} (only triangles are drawn)`
                );
                return undefined;
              }
              const index = primitive.material;
              if (index !== undefined && !materials.materials[index])
                throw new Error(`Missing material ${index}`);
              const material =
                index !== undefined
                  ? materials.materials[index]
                  : materials.fallback!;
              const id = `mesh/${keys[m]}/${i}`;
              // The unlit materials need no normals: none are computed for them.
              this.ctx.provide(
                MeshDataType,
                id,
                await this.primitiveData(primitive, mesh.name, !material.unlit)
              );
              return {
                mesh: id,
                material:
                  index !== undefined
                    ? materials.ids[index]
                    : 'material/default',
              };
            }
          )
        );
        return {
          ...(mesh.name !== undefined ? { name: mesh.name } : {}),
          primitives: primitives.filter((p) => p !== undefined),
        };
      })
    );
  }

  async read(): Promise<ModelData> {
    const json = this.json;
    const materials = await this.readMaterials();
    const [meshes, skins, animations] = await Promise.all([
      this.readMeshes(materials),
      Promise.all(
        (json.skins ?? []).map((skin) => skinData(skin, this.accessor))
      ),
      Promise.all(
        (json.animations ?? []).map((animation) =>
          animationData(animation, this.accessor)
        )
      ),
    ]);
    const nodes = (json.nodes ?? []).map((node) => {
      let data = nodeData(node);
      for (const [ext, extension] of this.hooks(node, 'node'))
        data = extension.node(ext, data, this.context, node);
      return data;
    });
    let model: ModelData = {
      name: modelName(this.ctx.uri),
      nodes,
      roots: rootNodes(json),
      meshes,
      skins,
      animations,
      cameras: (json.cameras ?? []).map(cameraData),
      lights: [],
    };
    for (const [ext, extension] of this.hooks(json, 'model'))
      model = extension.model(ext, model, this.context);
    return model;
  }
}
