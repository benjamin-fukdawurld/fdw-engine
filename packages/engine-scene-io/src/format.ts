import {
  MaterialDataType,
  MeshDataType,
  type MaterialData,
} from '@fdw/engine-assets';
import {
  defineResourceType,
  ResourceError,
  type ResourceBytes,
  type ResourceLoader,
} from '@fdw/engine-resources';
import { parseGraph, type MaterialGraphData } from '@fdw/engine-shader';
import { SceneDataType, type SceneData } from './data';

// The format of the engine: the SceneData as JSON, the typed arrays (the
// vertices, the transforms of the batches, a heightfield) in a binary
// file beside it.

export const FdwSceneFormat = 'fdw-scene';

/** The binary file of a scene: a resource of its own, read once. */
export const SceneBufferType =
  defineResourceType<ResourceBytes>('scene-buffer');

export const sceneBufferLoader: ResourceLoader<ResourceBytes> = {
  type: SceneBufferType,
  load: (ctx) => ctx.bytes(),
  sizeOf: (bytes) => bytes.byteLength,
};
export const FdwSceneVersion = 1;

/** A file written by an exporter. */
export interface ExportedFile {
  /** Relative to where the files are written. */
  readonly path: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Writes a scene in a format: the files to write together. */
export interface SceneExporter<O = object> {
  readonly format: string;
  readonly extensions: readonly string[];
  write(data: SceneData, path: string, options?: O): Promise<ExportedFile[]>;
}

/**
 * The migrations of the documents: `migrations[n]` brings a document of
 * version n to n + 1. Empty while the format has a single version.
 */
export const fdwSceneMigrations: Record<
  number,
  (document: Record<string, unknown>) => Record<string, unknown>
> = {};

type TypedArray =
  | Float32Array<ArrayBuffer>
  | Float64Array<ArrayBuffer>
  | Int8Array<ArrayBuffer>
  | Int16Array<ArrayBuffer>
  | Int32Array<ArrayBuffer>
  | Uint8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>;

const arrayTypes = {
  f32: Float32Array,
  f64: Float64Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
} as const;
type ArrayTypeName = keyof typeof arrayTypes;

const typeName = (array: ArrayBufferView): ArrayTypeName | undefined =>
  (Object.keys(arrayTypes) as ArrayTypeName[]).find(
    (name) => array instanceof arrayTypes[name],
  );

/** A typed array in the binary file. */
interface BinaryRef {
  readonly $binary: {
    readonly type: ArrayTypeName;
    readonly byteOffset: number;
    readonly length: number;
  };
}

const isBinaryRef = (value: unknown): value is BinaryRef =>
  typeof value === 'object' && value !== null && '$binary' in value;

export interface FdwSceneOptions {
  /**
   * `'separate'` (the default): the binary in a `.bin` file beside the
   * JSON; `'embedded'`: in the JSON, in base64 (a single file, larger).
   */
  readonly binary?: 'separate' | 'embedded';
  /** Indentation of the JSON: 2 by default, 0 for none. */
  readonly indent?: number;
}

/**
 * Writes a scene as `path` (`levels/forest.scene.json`) and its binary
 * (`levels/forest.scene.bin`). The graphs of the materials are written
 * once each.
 */
export async function writeFdwScene(
  data: SceneData,
  path: string,
  options: FdwSceneOptions = {},
): Promise<ExportedFile[]> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const binary = (array: ArrayBufferView): BinaryRef => {
    const type = typeName(array);
    if (!type) throw new Error('Unsupported typed array in a scene');
    // Aligned on 8 bytes: every array type can view it in place.
    const padding = (8 - (length % 8)) % 8;
    if (padding) chunks.push(new Uint8Array(padding));
    length += padding;
    const byteOffset = length;
    chunks.push(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
    );
    length += array.byteLength;
    return {
      $binary: {
        type,
        byteOffset,
        length: array.byteLength / (array as TypedArray).BYTES_PER_ELEMENT,
      },
    };
  };
  const graphs: MaterialGraphData[] = [];
  const graphIndex = new Map<MaterialGraphData, number>();
  const materials = data.materials.map((material) => {
    if (material.kind !== 'graph') return material;
    let index = graphIndex.get(material.graph);
    if (index === undefined) {
      index = graphs.length;
      graphs.push(material.graph);
      graphIndex.set(material.graph, index);
    }
    return { ...material, graph: index };
  });
  const body = encode(
    {
      name: data.name,
      nodes: data.nodes,
      batches: data.batches,
      meshes: data.meshes,
      materials,
      graphs: graphs.length > 0 ? graphs : undefined,
    },
    binary,
  ) as Record<string, unknown>;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const embedded = options.binary === 'embedded';
  const binPath = path.replace(/(\.json)?$/i, '').concat('.bin');
  const binName = binPath.slice(binPath.lastIndexOf('/') + 1);
  const document = {
    format: FdwSceneFormat,
    schemaVersion: FdwSceneVersion,
    ...(length > 0
      ? {
          buffers: [
            {
              uri: embedded
                ? `data:application/octet-stream;base64,${base64(bytes)}`
                : binName,
              byteLength: length,
            },
          ],
        }
      : {}),
    ...body,
  };
  const json = JSON.stringify(document, null, options.indent ?? 2);
  const files: ExportedFile[] = [
    { path, bytes: new TextEncoder().encode(json) },
  ];
  if (length > 0 && !embedded) files.push({ path: binPath, bytes });
  return files;
}

// The JSON of a value, its typed arrays written by `binary`; without the
// undefined fields.
function encode(
  value: unknown,
  binary: (array: ArrayBufferView) => BinaryRef,
): unknown {
  if (ArrayBuffer.isView(value)) return binary(value);
  if (Array.isArray(value)) return value.map((v) => encode(v, binary));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value))
      if (v !== undefined) out[key] = encode(v, binary);
    return out;
  }
  return value;
}

function decode(value: unknown, buffer: ResourceBytes | undefined): unknown {
  if (isBinaryRef(value)) {
    if (!buffer) throw new Error('A binary array without a buffer');
    const { type, byteOffset, length } = value.$binary;
    const Type = arrayTypes[type];
    if (!Type) throw new Error(`Unknown binary type ${type}`);
    const end = byteOffset + length * Type.BYTES_PER_ELEMENT;
    if (end > buffer.byteLength)
      throw new Error('A binary array past its buffer');
    // A copy: the arrays own their memory, aligned.
    return new Type(
      buffer.buffer.slice(
        buffer.byteOffset + byteOffset,
        buffer.byteOffset + end,
      ),
    );
  }
  if (Array.isArray(value)) return value.map((v) => decode(v, buffer));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = decode(v, buffer);
    return out;
  }
  return value;
}

/** Brings a document to the current version by its migrations. */
export function migrateFdwScene(
  document: Record<string, unknown>,
  migrations = fdwSceneMigrations,
  current = FdwSceneVersion,
): Record<string, unknown> {
  if (document['format'] !== FdwSceneFormat) {
    throw new Error(
      `Not a scene of the engine (format ${String(document['format'])})`,
    );
  }
  let version = document['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new Error(`Invalid schemaVersion ${String(version)}`);
  if (version > current)
    throw new Error(
      `Scene of version ${version}, newer than this engine (${current})`,
    );
  while (version < current) {
    const migrate = migrations[version];
    if (!migrate) throw new Error(`No migration from version ${version}`);
    document = { ...migrate(document), schemaVersion: version + 1 };
    version++;
  }
  return document;
}

/**
 * Reads a document of the format, its typed arrays from `buffer`. Checks
 * the format, migrates older versions, validates the graphs.
 */
export function parseFdwScene(
  source: string | Record<string, unknown>,
  buffer?: ResourceBytes,
): SceneData {
  const document = migrateFdwScene(
    typeof source === 'string' ? JSON.parse(source) : source,
  );
  const graphs = ((document['graphs'] as unknown[] | undefined) ?? []).map(
    (graph) => parseGraph(graph),
  );
  const body = decode(document, buffer) as Record<string, unknown>;
  const list = (key: string) => {
    const value = body[key] ?? [];
    if (!Array.isArray(value)) throw new Error(`"${key}" is not an array`);
    return value;
  };
  const materials = list('materials').map((material: MaterialData) => {
    if (material.kind !== 'graph') return material;
    const graph = graphs[material.graph as unknown as number];
    if (!graph) throw new Error(`Material ${material.name ?? ''}: no graph`);
    return { ...material, graph };
  });
  const nodes = list('nodes');
  nodes.forEach((node: { parent?: number }, i: number) => {
    if (node.parent !== undefined && !(node.parent >= 0 && node.parent < i))
      throw new Error(`Node ${i}: its parent must come before it`);
  });
  return {
    name: body['name'] as string | undefined,
    nodes,
    batches: list('batches'),
    meshes: list('meshes'),
    materials,
  };
}

/**
 * Loads the scenes of the engine (`.scene.json`): their meshes and
 * materials are sub-resources (`forest.scene.json#mesh/0`), shared by the
 * instances of the scene.
 */
export const fdwSceneLoader: ResourceLoader<SceneData> = {
  type: SceneDataType,
  extensions: ['json'],
  sniff: (head) => new TextDecoder().decode(head).includes('"fdw-scene"'),
  async load(ctx) {
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(await ctx.text()) as Record<string, unknown>;
    } catch (e) {
      throw new ResourceError(
        'decode',
        ctx.uri,
        `Invalid JSON: ${(e as Error).message}`,
      );
    }
    const buffers =
      (document['buffers'] as { uri: string }[] | undefined) ?? [];
    let buffer: ResourceBytes | undefined;
    if (buffers.length > 0) {
      const { uri } = buffers[0];
      buffer = uri.startsWith('data:')
        ? fromBase64(uri.slice(uri.indexOf(',') + 1))
        : await ctx.use(SceneBufferType, ctx.resolve(uri)).ready;
    }
    const data = parseFdwScene(document, buffer);
    data.meshes.forEach((mesh, i) =>
      ctx.provide(MeshDataType, `mesh/${i}`, mesh),
    );
    data.materials.forEach((material, i) =>
      ctx.provide(MaterialDataType, `material/${i}`, material),
    );
    return data;
  },
};

/** The exporter of the format of the engine. */
export const fdwSceneExporter: SceneExporter<FdwSceneOptions> = {
  format: FdwSceneFormat,
  extensions: ['scene.json'],
  write: writeFdwScene,
};

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): ResourceBytes {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
