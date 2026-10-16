import type { MeshData } from '@fdw/engine-assets';
import {
  buffersOf,
  owned,
  runTask,
  type DecodePool,
  type WorkerTasks,
} from '@fdw/engine-resources';
import {
  accessorReader,
  packAccessors,
  type PackedAccessors,
} from './accessors';
import type { GltfAttributeData, GltfDecodedPrimitive } from './extension';
import { readPrimitive, type PrimitiveSource } from './geometry';
import type { DracoDecoder, MeshoptDecoder } from './options';
import type { GltfJson } from './types';

// The decoding of glTF in the workers of `GltfOptions.workers`: the jobs
// posted by the loader, and the tasks of the worker script that answer
// them (`gltfWorkerTasks`, from `@fdw/engine-gltf/worker`, which imports
// nothing of the engine but its decoders).

/** The names of the tasks of `gltfWorkerTasks`. */
export const gltfTasks = {
  primitive: 'gltf/primitive',
  meshopt: 'gltf/meshopt',
  draco: 'gltf/draco',
} as const;

interface PrimitiveJob {
  readonly source: PrimitiveSource;
  readonly accessors: PackedAccessors;
}

export interface MeshoptJob {
  readonly source: Uint8Array<ArrayBuffer>;
  readonly count: number;
  readonly size: number;
  readonly mode: string;
  readonly filter?: string;
}

export interface DracoJob {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly attributes: Readonly<Record<string, number>>;
}

const ownedAttribute = (data: GltfAttributeData): GltfAttributeData => ({
  ...data,
  array: owned(data.array),
});

// The arrays of a decoded primitive, each over a buffer of its own.
function ownedPrimitive(decoded: GltfDecodedPrimitive): GltfDecodedPrimitive {
  return {
    attributes: Object.fromEntries(
      Object.entries(decoded.attributes).map(([name, data]) => [
        name,
        ownedAttribute(data),
      ]),
    ),
    ...(decoded.indices && { indices: owned(decoded.indices) }),
  };
}

const decodedViews = (decoded: GltfDecodedPrimitive | undefined) =>
  decoded
    ? [
        ...Object.values(decoded.attributes).map((a) => a.array),
        decoded.indices,
      ]
    : [];

/**
 * The `MeshData` of a primitive, read in a worker: the accessors it uses
 * are packed (their ranges copied), the decoded arrays copied, and all of
 * them moved to the worker; the vertices come back moved too.
 */
export async function readPrimitiveInWorker(
  pool: DecodePool,
  source: PrimitiveSource,
  json: GltfJson,
  bufferView: (index: number) => Promise<Uint8Array<ArrayBuffer>>,
  signal?: AbortSignal,
): Promise<MeshData> {
  const { decoded } = source;
  const used = Object.keys(source.attributes);
  // Only what the primitive reads of the decoded data, copied: an extension
  // may share its arrays.
  const copied: GltfDecodedPrimitive | undefined = decoded && {
    attributes: Object.fromEntries(
      used
        .filter((name) => decoded.attributes[name])
        .map((name) => {
          const data = decoded.attributes[name];
          return [name, { ...data, array: data.array.slice() }];
        }),
    ),
    ...(decoded.indices && { indices: decoded.indices.slice() }),
  };
  const accessors = await packAccessors(
    json,
    [
      ...used
        .filter((name) => !copied?.attributes[name])
        .map((name) => source.attributes[name]),
      ...(source.indices !== undefined && !copied?.indices
        ? [source.indices]
        : []),
    ],
    bufferView,
  );
  const job: PrimitiveJob = {
    source: { ...source, decoded: copied },
    accessors,
  };
  return runTask<MeshData>(pool, gltfTasks.primitive, job, {
    transfer: buffersOf([...accessors.views, ...decodedViews(copied)]),
    signal,
  });
}

/** What the worker script decodes with: the decoders the files need. */
export interface GltfWorkerOptions {
  /** For `EXT_meshopt_compression`: the `MeshoptDecoder` of `meshoptimizer`. */
  readonly meshopt?: MeshoptDecoder;
  /** For `KHR_draco_mesh_compression`: a `DracoDecoder` over `draco3d`, built in the worker. */
  readonly draco?: DracoDecoder;
}

/**
 * The tasks of the glTF loader for `taskHandler`, in the worker script of
 * the pool given as `GltfOptions.workers`:
 *
 * ```ts
 * import { taskHandler } from '@fdw/engine-resources';
 * import { serveWorker } from '@fdw/engine-resources-web';
 * import { gltfWorkerTasks } from '@fdw/engine-gltf/worker';
 * import { MeshoptDecoder } from 'meshoptimizer';
 *
 * serveWorker(taskHandler(gltfWorkerTasks({ meshopt: MeshoptDecoder })));
 * ```
 */
export function gltfWorkerTasks({
  meshopt,
  draco,
}: GltfWorkerOptions = {}): WorkerTasks {
  return {
    [gltfTasks.primitive]: async ({ source, accessors }: PrimitiveJob) => {
      const read = accessorReader(
        accessors.json as GltfJson,
        async (index) => accessors.views[index],
      );
      const mesh = await readPrimitive(source, read);
      const result: MeshData = {
        ...mesh,
        vertices: mesh.vertices.map(owned),
        ...(mesh.indices && { indices: owned(mesh.indices) }),
      };
      return {
        result,
        transfer: buffersOf([...result.vertices, result.indices]),
      };
    },
    [gltfTasks.meshopt]: async ({
      source,
      count,
      size,
      mode,
      filter,
    }: MeshoptJob) => {
      if (!meshopt)
        throw new Error(
          'EXT_meshopt_compression needs a decoder: gltfWorkerTasks({ meshopt })',
        );
      await meshopt.ready;
      const target = new Uint8Array(count * size);
      meshopt.decodeGltfBuffer(target, count, size, source, mode, filter);
      return { result: target, transfer: [target.buffer] };
    },
    [gltfTasks.draco]: async ({ bytes, attributes }: DracoJob) => {
      if (!draco)
        throw new Error(
          'KHR_draco_mesh_compression needs a decoder: gltfWorkerTasks({ draco })',
        );
      const decoded = ownedPrimitive(await draco.decode(bytes, attributes));
      return { result: decoded, transfer: buffersOf(decodedViews(decoded)) };
    },
  };
}
