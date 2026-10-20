import {
  modelInstanceOf,
  type ModelInstanceRecord,
  type ModelNodeData,
} from '@fdw/engine-assets';
import {
  AllLayers,
  TransformLayout,
  type Material,
  type Mesh,
} from '@fdw/engine-core';
import type { ResourceStore } from '@fdw/engine-resources';
import { NodeFlags, type Node, type Scene } from '@fdw/engine-scene';
import { SceneCodecs, type ComponentCodec } from './codec';
import { sceneCodecs } from './codecs';
import type {
  InstanceData,
  NodeFields,
  OverrideData,
  SceneBatchData,
  SceneData,
  SceneNodeData,
} from './data';
import {
  instanceMembers,
  isMember,
  memberPath,
  modelPaths,
  sceneInstanceOf,
  scenePaths,
  type SceneInstanceRecord,
} from './members';
import { clean, diffFields, SceneWriter } from './writer';

export { sameData } from './writer';

export interface CaptureOptions {
  /** The store whose values are written by URI (ResourceStore.identify). */
  readonly store?: ResourceStore;
  /** The codecs of the components; those of engine-scene by default. */
  readonly codecs?: SceneCodecs | Iterable<ComponentCodec<any>>;
  /** The branch written: the descendants of this node. The root of the scene by default. */
  readonly root?: Node | number;
  /** The URI the scene will be written at: the references are relative to it. */
  readonly uri?: string;
  readonly name?: string;
  /**
   * The instances of models and scenes: by `reference` (the default),
   * their source and their changes; `expand`ed, their nodes as the others
   * (an export to a format without references).
   */
  readonly instances?: 'reference' | 'expand';
  /** Leaf nodes alike, at least this many under a parent, are written as a batch. 16 by default. */
  readonly batchMin?: number;
  /** Receives what could not be written. console.warn by default. */
  readonly warn?: (message: string) => void;
}

const None = -1;

/** An instance found in the branch written: its source, its members. */
interface Instance {
  readonly data: InstanceData;
  readonly members: ReadonlySet<number>;
  /** The path of a member, for the nodes added under it. */
  pathOf(entity: number): string | undefined;
  overrides(): OverrideData[];
}

export function codecsOf(
  codecs: SceneCodecs | Iterable<ComponentCodec<any>> | undefined,
): SceneCodecs {
  return codecs instanceof SceneCodecs
    ? codecs
    : new SceneCodecs(codecs ?? sceneCodecs);
}

/**
 * Writes a branch of a scene as SceneData: its nodes, their components by
 * their codecs, the resources by URI when the store made them, the meshes
 * and materials made in code with the scene. Leaf nodes alike become
 * batches; the instances of models and scenes, their source and their
 * changes.
 */
export function captureScene(
  scene: Scene,
  options: CaptureOptions = {},
): SceneData {
  const { store } = options;
  const warn = options.warn ?? ((m: string) => console.warn(`[scene-io] ${m}`));
  const codecs = codecsOf(options.codecs);
  const rootEntity =
    options.root === undefined
      ? scene.root.entity
      : typeof options.root === 'number'
        ? options.root
        : options.root.entity;
  const batchMin = options.batchMin ?? 16;
  const { Hierarchy, NodeState, MeshRenderer } = scene;
  const index = new Map<number, number>();
  const writer = new SceneWriter(scene, {
    store,
    codecs,
    uri: options.uri,
    indexOf: (entity) => index.get(entity),
    warn,
  });

  const children = (entity: number): number[] => {
    const list: number[] = [];
    for (let c = Hierarchy.first[entity]; c !== None; c = Hierarchy.next[c])
      list.push(c);
    return list;
  };

  // --- What each entity becomes ---------------------------------------------
  // The entities in depth-first order; the roots of the instances (written
  // by reference when the store knows their source).
  const order: number[] = [];
  const instances = new Map<number, Instance>();
  // The entities made by an instance: written as its changes.
  const ownedBy = new Map<number, number>();
  const visit = (entity: number) => {
    order.push(entity);
    const instance =
      options.instances === 'expand' ? undefined : instanceAt(entity);
    if (instance) {
      instances.set(entity, instance);
      for (const member of instance.members) ownedBy.set(member, entity);
    }
    const walk = (parent: number) => {
      for (const child of children(parent)) {
        // A node of the instance: its own children may be added nodes.
        if (ownedBy.get(child) === entity && instance) walk(child);
        else visit(child);
      }
    };
    walk(entity);
  };

  function instanceAt(entity: number): Instance | undefined {
    const model = modelInstanceOf(scene, entity);
    if (model) {
      const ref = writer.resource(model.model);
      return ref === undefined ? undefined : modelInstance(entity, model, ref);
    }
    const record = sceneInstanceOf(scene, entity);
    if (record) {
      const ref = store?.identify(record.data) && writer.resource(record.data);
      return ref === undefined ? undefined : sceneInstance(entity, record, ref);
    }
    return undefined;
  }

  // An instance of a model: its changes against what the model makes.
  function modelInstance(
    root: number,
    record: ModelInstanceRecord,
    ref: InstanceData['model'],
  ): Instance {
    const members = instanceMembers(scene, root, record);
    const { data, meshes: primitives } = record.model;
    const paths = modelPaths(data);
    const expected = (
      node: ModelNodeData | undefined,
      primitive: { mesh: Mesh; material: Material } | undefined,
    ): NodeFields =>
      clean({
        position: node?.translation ?? [0, 0, 0],
        rotation: node?.rotation ?? [0, 0, 0, 1],
        scale: node?.scale ?? [1, 1, 1],
        components: primitive
          ? {
              'mesh renderer': {
                version: 1,
                data: clean({
                  mesh: writer.mesh(primitive.mesh),
                  material: writer.material(primitive.material),
                  castShadow: record.castShadow ? undefined : false,
                }),
              },
            }
          : undefined,
      });
    const lights = new Set(['light']);
    return {
      data: clean({
        model: ref,
        castShadow: record.castShadow ? undefined : false,
        lights: record.lights ? undefined : false,
      }),
      members,
      pathOf: (entity) => memberPath(scene, record, entity),
      overrides() {
        const overrides: OverrideData[] = [];
        const compare = (
          entity: number | undefined,
          path: string,
          want: NodeFields,
          skip?: ReadonlySet<string>,
        ) => {
          if (entity === undefined || !members.has(entity)) {
            overrides.push({ path, removed: true });
            return;
          }
          const diff = diffFields(writer.fields(entity, skip), want);
          if (diff) overrides.push({ path, ...diff });
        };
        // From the roots: a node removed takes its descendants with it.
        const walk = (i: number) => {
          const node = data.nodes[i];
          const entity = record.nodes[i];
          const alive = members.has(entity);
          const prims =
            node.mesh !== undefined ? (primitives[node.mesh] ?? []) : [];
          compare(
            alive ? entity : undefined,
            paths[i],
            expected(node, prims.length === 1 ? prims[0] : undefined),
            node.light !== undefined && record.lights ? lights : undefined,
          );
          if (!alive) return;
          if (prims.length > 1) {
            const name = NodeState.label[entity] as string;
            prims.forEach((prim, k) => {
              const label = `${name}#${k}`;
              const sub = children(entity).find(
                (c) => members.has(c) && NodeState.label[c] === label,
              );
              compare(sub, `${paths[i]}/${label}`, expected(undefined, prim));
            });
          }
          for (const child of node.children) walk(child);
        };
        for (const i of data.roots) walk(i);
        return overrides;
      },
    };
  }

  // An instance of a scene: its changes against what its nodes were made with.
  function sceneInstance(
    root: number,
    record: SceneInstanceRecord,
    ref: InstanceData['scene'],
  ): Instance {
    const members = new Set<number>();
    for (const entity of record.members.keys())
      if (isMember(scene, record.members, entity)) members.add(entity);
    members.delete(root);
    const paths = scenePaths(record.data);
    const absolute = new SceneWriter(scene, {
      store,
      codecs,
      absolute: true,
      warn: () => undefined,
    });
    return {
      data: { scene: ref },
      members,
      pathOf(entity) {
        const i = record.nodes.indexOf(entity);
        return i >= 0 ? paths[i] : undefined;
      },
      overrides() {
        const overrides: OverrideData[] = [];
        const removed = new Set<number>();
        record.data.nodes.forEach((node, i) => {
          const path = paths[i];
          if (path === undefined) return;
          if (node.parent !== undefined && removed.has(node.parent)) {
            removed.add(i);
            return;
          }
          const entity = record.nodes[i];
          if (!members.has(entity)) {
            removed.add(i);
            overrides.push({ path, removed: true });
            return;
          }
          const diff = diffFields(absolute.fields(entity), record.baseline[i]);
          if (!diff) return;
          // The components changed, written as the scene writes them.
          const { components, ...rest } = diff;
          const written = components && writer.components(entity);
          overrides.push(
            clean({
              path,
              ...rest,
              components: written
                ? Object.fromEntries(
                    Object.keys(components).map((name) => [
                      name,
                      written[name],
                    ]),
                  )
                : undefined,
            }),
          );
        });
        return overrides;
      },
    };
  }

  for (const child of children(rootEntity)) visit(child);

  // Leaf renderers alike under a parent: batches.
  const flagsOf = (e: number) =>
    NodeState.flags[e] &
    (NodeFlags.Hidden | NodeFlags.Static | NodeFlags.Occluder);
  const groups = new Map<string, number[]>();
  for (const entity of order) {
    if (
      Hierarchy.first[entity] !== None ||
      instances.has(entity) ||
      ownedBy.has(Hierarchy.parent[entity]) ||
      !MeshRenderer.has(entity)
    )
      continue;
    const key = [
      Hierarchy.parent[entity],
      NodeState.label[entity],
      flagsOf(entity),
      NodeState.layers[entity],
      objectKey(MeshRenderer.mesh[entity] as object),
      objectKey(MeshRenderer.material[entity] as object),
      MeshRenderer.noShadow[entity],
    ].join('|');
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(entity);
  }
  const batched = new Set<number>();
  const batchGroups = [...groups.values()].filter((g) => g.length >= batchMin);
  for (const group of batchGroups) for (const e of group) batched.add(e);

  // --- Indices ------------------------------------------------------------------
  const nodeEntities = order.filter((e) => !batched.has(e));
  nodeEntities.forEach((e, i) => index.set(e, i));
  let next = nodeEntities.length;
  for (const group of batchGroups) for (const e of group) index.set(e, next++);

  // --- Writing ----------------------------------------------------------------------
  const nodes: SceneNodeData[] = nodeEntities.map((entity) => {
    const parentEntity = Hierarchy.parent[entity];
    const owner = ownedBy.get(parentEntity);
    const node: SceneNodeData = {
      ...writer.fields(entity),
      ...(parentEntity === rootEntity
        ? {}
        : owner !== undefined
          ? {
              parent: index.get(owner),
              parentPath: instances.get(owner)!.pathOf(parentEntity),
            }
          : { parent: index.get(parentEntity) }),
    };
    const instance = instances.get(entity);
    if (!instance) return clean(node);
    const overrides = instance.overrides();
    return clean({
      ...node,
      instance: clean({
        ...instance.data,
        overrides: overrides.length > 0 ? overrides : undefined,
      }),
    });
  });

  const skipRenderer = new Set(['mesh renderer']);
  const batches: SceneBatchData[] = batchGroups.map((group) => {
    const first = group[0];
    const count = group.length;
    const positions = new Float32Array(count * 3);
    const rotations = new Float32Array(count * 4);
    const scales = new Float32Array(count * 3);
    const d = scene.transforms.data;
    const { stride, position: P, rotation: R, scale: S } = TransformLayout;
    group.forEach((e, i) => {
      const o = e * stride;
      positions.set(d.subarray(o + P, o + P + 3), i * 3);
      rotations.set(d.subarray(o + R, o + R + 4), i * 4);
      scales.set(d.subarray(o + S, o + S + 3), i * 3);
    });
    const columns: Record<string, { version: number; data: unknown[] }> = {};
    group.forEach((e, i) => {
      for (const [name, value] of Object.entries(
        writer.components(e, skipRenderer) ?? {},
      )) {
        const column = (columns[name] ??= {
          version: value.version,
          data: new Array(count).fill(null),
        });
        column.data[i] = value.data;
      }
    });
    const flags = NodeState.flags[first];
    const layers = NodeState.layers[first];
    const parent = Hierarchy.parent[first];
    return clean({
      parent: parent === rootEntity ? undefined : index.get(parent),
      name: (NodeState.label[first] as string) || undefined,
      count,
      positions,
      rotations,
      scales,
      visible: flags & NodeFlags.Hidden ? false : undefined,
      static: flags & NodeFlags.Static ? true : undefined,
      occluder: flags & NodeFlags.Occluder ? true : undefined,
      layers: layers !== AllLayers ? layers : undefined,
      mesh: writer.mesh(MeshRenderer.mesh[first] as Mesh),
      material: writer.material(MeshRenderer.material[first] as Material),
      castShadow: MeshRenderer.noShadow[first] ? false : undefined,
      components: Object.keys(columns).length > 0 ? columns : undefined,
    });
  });

  return {
    name: options.name,
    nodes,
    batches,
    meshes: writer.meshes,
    materials: writer.materials,
  };
}

// Identities of objects for the keys of the batches.
const keys = new WeakMap<object, number>();
let lastKey = 0;
const objectKey = (value: object): number => {
  let key = keys.get(value);
  if (key === undefined) keys.set(value, (key = ++lastKey));
  return key;
};
