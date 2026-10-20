import {
  AssetsConfigService,
  ModelDataType,
  type CameraData,
  type LightData as GltfLightData,
  type ModelData,
} from '@fdw/engine-assets';
import type { ProjectionData } from '@fdw/engine-backend';
import type { Shape } from '@fdw/engine-physics';
import {
  ResourceError,
  type LoadContext,
  type ResourceLoader,
} from '@fdw/engine-resources';
import {
  SceneDataType,
  type ComponentData,
  type LightData,
  type SceneBatchData,
  type SceneData,
  type SceneNodeData,
} from '@fdw/engine-scene-io';
import { accessorReader, toFloat32 } from '../accessors';
import { BufferType } from '../buffers';
import { decodeDataUri, isGlb, parseGlb } from '../glb';
import { rootNodes, type Trs } from '../nodes';
import type { GltfJson, GltfNode } from '../types';
import { decodeBinary } from './binary';
import { importBodies } from './physics';

/** `FDW_scene` on a node: what glTF has no place for. */
export interface FdwSceneNode {
  /** The components of the engine, read instead of those made from glTF. */
  readonly components?: Readonly<Record<string, ComponentData>>;
  readonly node?: {
    readonly visible?: boolean;
    readonly static?: boolean;
    readonly occluder?: boolean;
    readonly layers?: number;
  };
  /** The mesh drawn casts no shadow. */
  readonly castShadow?: false;
  /** A node written for a collider of the parent's body: not a node of the scene. */
  readonly helper?: true;
  /**
   * A batch of the engine (`SceneBatchData`): the node holds its mesh and
   * its transforms (`EXT_mesh_gpu_instancing`), not a node of the scene.
   */
  readonly batch?: {
    readonly count: number;
    readonly visible?: boolean;
    readonly static?: boolean;
    readonly occluder?: boolean;
    readonly layers?: number;
    readonly castShadow?: false;
    /** The accessors of the transforms, when the batch has no mesh. */
    readonly attributes?: Readonly<Record<string, number>>;
    readonly components?: SceneBatchData['components'];
  };
}

const fdwOf = (node: GltfNode): FdwSceneNode | undefined =>
  node.extensions?.['FDW_scene'] as FdwSceneNode | undefined;

const degrees = (radians: number) => (radians * 180) / Math.PI;

/** The light of the engine `createLight` makes from KHR_lights_punctual. */
export function lightComponent(light: GltfLightData): LightData {
  const color = light.color.map((c) => c * light.intensity) as [
    number,
    number,
    number,
  ];
  const colors = {
    ambient: [0, 0, 0] as const,
    diffuse: color,
    specular: color,
  };
  if (light.type === 'directional') return { type: 'directional', ...colors };
  const attenuation = [1, 0, 1] as const;
  return light.type === 'point'
    ? { type: 'point', ...colors, attenuation }
    : {
        type: 'spot',
        ...colors,
        attenuation,
        innerCutoff: degrees(light.innerConeAngle ?? 0),
        outerCutoff: degrees(light.outerConeAngle ?? Math.PI / 4),
      };
}

/** The projection of the engine of a camera of glTF. */
export function cameraProjection(camera: CameraData): ProjectionData {
  return camera.type === 'perspective'
    ? {
        type: 'perspective',
        fov: degrees(camera.yfov),
        aspect: camera.aspectRatio ?? 1,
        near: camera.znear,
        far: camera.zfar ?? 1000,
      }
    : {
        type: 'orthographic',
        left: -camera.xmag,
        right: camera.xmag,
        bottom: -camera.ymag,
        top: camera.ymag,
        near: camera.znear,
        far: camera.zfar,
      };
}

const decodeUri = (uri: string): string => {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
};

/** The accessors of a file read outside the model loader (colliders, instances). */
function fileAccessors(
  ctx: LoadContext<unknown>,
  json: GltfJson,
  bin: Uint8Array<ArrayBuffer> | undefined,
) {
  const buffers = new Map<number, Promise<Uint8Array<ArrayBuffer>>>();
  const buffer = (index: number) => {
    let promise = buffers.get(index);
    if (!promise) {
      const b = json.buffers?.[index];
      if (!b) throw new Error(`Missing buffer ${index}`);
      promise =
        b.uri === undefined
          ? bin
            ? Promise.resolve(bin)
            : Promise.reject(new Error(`Buffer ${index} has no data`))
          : Promise.resolve(
              decodeDataUri(b.uri) ??
                ctx.use(BufferType, ctx.resolve(decodeUri(b.uri))).ready,
            );
      buffers.set(index, promise);
    }
    return promise;
  };
  const bufferView = async (index: number) => {
    const view = json.bufferViews?.[index];
    if (!view) throw new Error(`Missing buffer view ${index}`);
    if (view.extensions?.['EXT_meshopt_compression'])
      throw new Error(`Buffer view ${index} is compressed (meshopt)`);
    const bytes = await buffer(view.buffer);
    const start = view.byteOffset ?? 0;
    return bytes.subarray(start, start + view.byteLength);
  };
  return { accessor: accessorReader(json, bufferView), bufferView };
}

/**
 * The scenes of glTF files, as `SceneDataType`: the default scene, its
 * nodes with their meshes (the sub-resources of the model loader,
 * `#mesh/<id>`), lights, cameras, physics bodies (`KHR_physics_rigid_bodies`,
 * `KHR_implicit_shapes`), batches (`EXT_mesh_gpu_instancing`), and the
 * components of the engine (`FDW_scene`). Skins and animations are left to
 * the models.
 */
export const gltfSceneLoader: ResourceLoader<SceneData> = {
  type: SceneDataType,
  extensions: ['gltf', 'glb'],
  mimeTypes: ['model/gltf+json', 'model/gltf-binary'],
  sniff: isGlb,
  async load(ctx) {
    let warn: (message: string) => void;
    try {
      const config = ctx.service(AssetsConfigService);
      warn = config.warn;
    } catch {
      warn = (m) => console.warn(`[gltf] ${m}`);
    }
    const model = await ctx.use(ModelDataType, ctx.uri).ready;
    const bytes = await ctx.bytes();
    let json: GltfJson;
    let bin: Uint8Array<ArrayBuffer> | undefined;
    try {
      if (isGlb(bytes)) ({ json, bin } = parseGlb(bytes));
      else json = JSON.parse(new TextDecoder().decode(bytes)) as GltfJson;
    } catch (e) {
      throw new ResourceError('decode', ctx.uri, (e as Error).message, {
        cause: e,
      });
    }
    const { accessor, bufferView } = fileAccessors(ctx, json, bin);
    return sceneData(json, model, accessor, bufferView, (m) =>
      warn(`${ctx.uri}: ${m}`),
    );
  },
};

type Accessor = ReturnType<typeof accessorReader>;

/**
 * The SceneData of a glTF file, from its JSON, its model, and the readers
 * of its accessors and buffer views.
 */
export async function sceneData(
  json: GltfJson,
  model: ModelData,
  accessor: Accessor,
  bufferView: (index: number) => Promise<Uint8Array<ArrayBuffer>>,
  warn: (message: string) => void,
): Promise<SceneData> {
  const decode = <T>(value: T): Promise<T> =>
    decodeBinary(value, bufferView) as Promise<T>;
  const gltfNodes = json.nodes ?? [];
  const parents = new Map<number, number>();
  gltfNodes.forEach((node, i) =>
    (node.children ?? []).forEach((child) => parents.set(child, i)),
  );
  const trs = (i: number): Trs => {
    const n = model.nodes[i];
    return {
      translation: n.translation ?? [0, 0, 0],
      rotation: n.rotation ?? [0, 0, 0, 1],
      scale: n.scale ?? [1, 1, 1],
    };
  };

  // The nodes of the default scene, parents first: in the order of the file
  // when it is (the files of the engine), else depth first.
  const reached: number[] = [];
  const visit = (i: number) => {
    reached.push(i);
    for (const child of gltfNodes[i]?.children ?? []) visit(child);
  };
  for (const root of rootNodes(json)) visit(root);
  const inOrder = reached.every((i) => !parents.has(i) || parents.get(i)! < i);
  const order = inOrder ? [...reached].sort((a, b) => a - b) : reached;
  const kept = order.filter((i) => {
    const fdw = fdwOf(gltfNodes[i]);
    return !fdw?.helper && !fdw?.batch;
  });
  const index = new Map(kept.map((i, k) => [i, k]));

  const bodies = await importBodies({
    json,
    trs,
    parent: (i) => parents.get(i),
    meshShape: (mesh, convexHull, scale) =>
      meshShape(json, accessor, mesh, convexHull, scale, warn),
    warn,
  });

  const nodes: SceneNodeData[] = [];
  const extra: SceneNodeData[] = [];
  const batches: SceneBatchData[] = [];
  const primitivesOf = (i: number) => {
    const mesh = model.nodes[i].mesh;
    return mesh !== undefined ? (model.meshes[mesh]?.primitives ?? []) : [];
  };
  const renderer = (
    p: { mesh: string; material: string },
    castShadow?: false,
  ): ComponentData => ({
    version: 1,
    data: {
      mesh: `#${p.mesh}`,
      material: `#${p.material}`,
      ...(castShadow === false ? { castShadow } : {}),
    },
  });

  for (const i of kept) {
    const gltf = gltfNodes[i];
    const data = model.nodes[i];
    const fdw = fdwOf(gltf);
    const components: Record<string, ComponentData> = {};
    const primitives = primitivesOf(i);
    const instanced = gltf.extensions?.['EXT_mesh_gpu_instancing'] as
      { attributes?: Readonly<Record<string, number>> } | undefined;
    if (primitives.length === 1 && !instanced)
      components['mesh renderer'] = renderer(primitives[0], fdw?.castShadow);
    if (data.light !== undefined && model.lights[data.light])
      components['light'] = {
        version: 1,
        data: lightComponent(model.lights[data.light]),
      };
    if (data.camera !== undefined && model.cameras[data.camera])
      components['camera view'] = {
        version: 1,
        data: { projection: cameraProjection(model.cameras[data.camera]) },
      };
    const body = bodies.get(i);
    if (body) components['physics body'] = { version: 1, data: { body } };
    if (fdw?.components)
      Object.assign(components, await decode(fdw.components));

    const parent = parents.get(i);
    const t = trs(i);
    const node: SceneNodeData = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(parent !== undefined && index.has(parent)
        ? { parent: index.get(parent) }
        : {}),
      ...(data.translation ? { position: t.translation } : {}),
      ...(data.rotation ? { rotation: t.rotation } : {}),
      ...(data.scale ? { scale: t.scale } : {}),
      ...fdw?.node,
      ...(Object.keys(components).length > 0 ? { components } : {}),
    };
    nodes.push(node);
    const self = index.get(i)!;
    if (primitives.length > 1 && !instanced) {
      const name = data.name ?? `node ${i}`;
      primitives.forEach((p, k) =>
        extra.push({
          name: `${name}#${k}`,
          parent: self,
          components: { 'mesh renderer': renderer(p, fdw?.castShadow) },
        }),
      );
    }
    if (instanced) {
      for (const p of primitives)
        batches.push(
          await batchData(accessor, instanced.attributes ?? {}, {
            parent: self,
            mesh: `#${p.mesh}`,
            material: `#${p.material}`,
          }),
        );
    }
  }

  // The batches of the engine, in the order of the file.
  for (const i of order) {
    const fdw = fdwOf(gltfNodes[i]);
    if (!fdw?.batch) continue;
    const { count, attributes, components, ...fields } = fdw.batch;
    const primitives = primitivesOf(i);
    if (primitives.length > 1)
      warn(`batch node ${i}: only its first primitive is drawn`);
    const parent = parents.get(i);
    const instanced = gltfNodes[i].extensions?.['EXT_mesh_gpu_instancing'] as
      { attributes?: Readonly<Record<string, number>> } | undefined;
    const batch = await batchData(
      accessor,
      instanced?.attributes ?? attributes ?? {},
      {
        ...(parent !== undefined && index.has(parent)
          ? { parent: index.get(parent) }
          : {}),
        ...(model.nodes[i].name !== undefined
          ? { name: model.nodes[i].name }
          : {}),
        ...(primitives[0]
          ? {
              mesh: `#${primitives[0].mesh}`,
              material: `#${primitives[0].material}`,
            }
          : {}),
        ...fields,
        ...(components ? { components: await decode(components) } : {}),
      },
      count,
    );
    batches.push(batch);
  }

  return {
    name: model.name,
    nodes: [...nodes, ...extra],
    batches,
    meshes: [],
    materials: [],
  };
}

// A batch from the transforms of EXT_mesh_gpu_instancing.
async function batchData(
  accessor: Accessor,
  attributes: Readonly<Record<string, number>>,
  fields: Omit<SceneBatchData, 'count' | 'positions' | 'rotations' | 'scales'>,
  count?: number,
): Promise<SceneBatchData> {
  const read = async (name: string) =>
    attributes[name] !== undefined
      ? toFloat32(await accessor(attributes[name]))
      : undefined;
  const [t, r, s] = await Promise.all([
    read('TRANSLATION'),
    read('ROTATION'),
    read('SCALE'),
  ]);
  const n =
    count ?? (t ? t.length / 3 : r ? r.length / 4 : s ? s.length / 3 : 0);
  const filled = (size: number, value: readonly number[]) => {
    const out = new Float32Array(n * size);
    for (let i = 0; i < n; i++) out.set(value, i * size);
    return out;
  };
  return {
    ...fields,
    count: n,
    positions: t ? Float32Array.from(t) : new Float32Array(n * 3),
    rotations: r ? Float32Array.from(r) : filled(4, [0, 0, 0, 1]),
    scales: s ? Float32Array.from(s) : filled(3, [1, 1, 1]),
  };
}

// The collision geometry of a mesh: its triangles, or the hull of its points.
async function meshShape(
  json: GltfJson,
  accessor: Accessor,
  meshIndex: number,
  convexHull: boolean,
  scale: readonly [number, number, number],
  warn: (message: string) => void,
): Promise<Shape | undefined> {
  const mesh = json.meshes?.[meshIndex];
  if (!mesh) {
    warn(`missing collider mesh ${meshIndex}`);
    return undefined;
  }
  const positions: number[] = [];
  const indices: number[] = [];
  for (const primitive of mesh.primitives) {
    const position = primitive.attributes['POSITION'];
    if (position === undefined) continue;
    const mode = primitive.mode ?? 4;
    if (!convexHull && mode !== 4) {
      warn(`collider mesh ${meshIndex}: only triangle lists are read`);
      continue;
    }
    const base = positions.length / 3;
    const points = toFloat32(await accessor(position));
    for (let k = 0; k < points.length; k++)
      positions.push(points[k] * Math.abs(scale[k % 3]));
    if (convexHull) continue;
    if (primitive.indices !== undefined) {
      const { array } = await accessor(primitive.indices);
      for (const i of array) indices.push(base + i);
    } else {
      for (let i = 0; i < points.length / 3; i++) indices.push(base + i);
    }
  }
  if (positions.length === 0) return undefined;
  return convexHull
    ? { type: 'convex', points: Float32Array.from(positions) }
    : {
        type: 'mesh',
        vertices: Float32Array.from(positions),
        indices: Uint32Array.from(indices),
      };
}
