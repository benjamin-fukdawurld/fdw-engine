import {
  isInstanceMember,
  type ModelData,
  type ModelInstanceRecord,
} from '@fdw/engine-assets';
import type { Component, Scene, World } from '@fdw/engine-scene';
import type { ComponentData, NodeFields, SceneData } from './data';

// The nodes of the instances of models, found by their paths; the
// components read without a codec, kept to be written again.

const None = -1;
const paths = new WeakMap<ModelData, readonly string[]>();

/**
 * The path of each node of a model from the root of its instances: the
 * names of its ancestors and its own; `#k` for the k-th child (in the
 * order of the model) when a name repeats among siblings.
 */
export function modelPaths(data: ModelData): readonly string[] {
  let list = paths.get(data);
  if (list) return list;
  const out: string[] = new Array(data.nodes.length);
  const segment = (siblings: readonly number[], k: number) => {
    const name = data.nodes[siblings[k]].name ?? `node ${siblings[k]}`;
    const repeated = siblings.some(
      (s, j) => j !== k && (data.nodes[s].name ?? `node ${s}`) === name,
    );
    return repeated || name.startsWith('#') ? `#${k}` : name;
  };
  const walk = (siblings: readonly number[], prefix: string) =>
    siblings.forEach((index, k) => {
      out[index] = prefix + segment(siblings, k);
      walk(data.nodes[index].children, `${out[index]}/`);
    });
  walk(data.roots, '');
  paths.set(data, (list = out));
  return list;
}

/** The members of an instance still alive under its root. */
export function instanceMembers(
  scene: Scene,
  root: number,
  record: ModelInstanceRecord,
): Set<number> {
  const members = new Set<number>();
  const { Hierarchy } = scene;
  for (const entity of record.members.keys()) {
    if (!isInstanceMember(scene, record, entity)) continue;
    let e = Hierarchy.parent[entity];
    while (e !== None && e !== root && isInstanceMember(scene, record, e))
      e = Hierarchy.parent[e];
    if (e === root) members.add(entity);
  }
  return members;
}

/** The path of a member of an instance (a node of the model, or the child holding a primitive). */
export function memberPath(
  scene: Scene,
  record: ModelInstanceRecord,
  entity: number,
): string | undefined {
  const index = record.nodes.indexOf(entity);
  if (index >= 0) return modelPaths(record.model.data)[index];
  const parent = scene.Hierarchy.parent[entity];
  const parentPath =
    parent !== None ? memberPath(scene, record, parent) : undefined;
  return parentPath !== undefined
    ? `${parentPath}/${scene.NodeState.label[entity] as string}`
    : undefined;
}

/** The member of an instance at a path, if any. */
export function resolveMember(
  scene: Scene,
  record: ModelInstanceRecord,
  path: string,
): number | undefined {
  const list = modelPaths(record.model.data);
  const index = list.indexOf(path);
  if (index >= 0)
    return isInstanceMember(scene, record, record.nodes[index])
      ? record.nodes[index]
      : undefined;
  const slash = path.lastIndexOf('/');
  if (slash < 0) return undefined;
  const parent = resolveMember(scene, record, path.slice(0, slash));
  if (parent === undefined) return undefined;
  const label = path.slice(slash + 1);
  const { Hierarchy, NodeState } = scene;
  for (let c = Hierarchy.first[parent]; c !== None; c = Hierarchy.next[c])
    if (isInstanceMember(scene, record, c) && NodeState.label[c] === label)
      return c;
  return undefined;
}

/**
 * What the root of an instance of a scene remembers (component `scene
 * instance`): the scene, the entity of each of its nodes, every entity
 * made (with its generation), and what each node was made with, to write
 * its changes.
 */
export interface SceneInstanceRecord {
  readonly data: SceneData;
  /** The entity of each node of the data (not of its batches). */
  readonly nodes: readonly number[];
  readonly members: ReadonlyMap<number, number>;
  /** The fields of each node once made, with canonical URIs (SceneWriter absolute). */
  readonly baseline: readonly NodeFields[];
}

type RecordSchema = { record: 'ref' };
const sceneInstances = new WeakMap<World, Component<RecordSchema>>();

/** The component of the roots of the instances of scenes: `record`, a SceneInstanceRecord. */
export function sceneInstanceComponent(scene: Scene): Component<RecordSchema> {
  let component = sceneInstances.get(scene.world);
  if (!component) {
    component = scene.world.defineComponent('scene instance', {
      record: 'ref',
    });
    sceneInstances.set(scene.world, component);
  }
  return component;
}

/** The record of the instance of a scene whose root is `entity`, if it is one. */
export function sceneInstanceOf(
  scene: Scene,
  entity: number,
): SceneInstanceRecord | undefined {
  const component = sceneInstances.get(scene.world);
  return component?.has(entity)
    ? (component.record[entity] as SceneInstanceRecord)
    : undefined;
}

/** Whether an entity is one of `members`, alive and not reused. */
export const isMember = (
  scene: Scene,
  members: ReadonlyMap<number, number>,
  entity: number,
): boolean =>
  scene.world.isAlive(entity) &&
  members.get(entity) === scene.world.generation(entity);

const scenePathCache = new WeakMap<
  SceneData,
  readonly (string | undefined)[]
>();

/**
 * The path of each node of a scene from the root of its instances, as
 * modelPaths; none for the nodes under a node of an instance (parentPath).
 */
export function scenePaths(data: SceneData): readonly (string | undefined)[] {
  let list = scenePathCache.get(data);
  if (list) return list;
  const out: (string | undefined)[] = new Array(data.nodes.length);
  const children = new Map<number | undefined, number[]>();
  data.nodes.forEach((node, i) => {
    if (node.parentPath !== undefined) return;
    let siblings = children.get(node.parent);
    if (!siblings) children.set(node.parent, (siblings = []));
    siblings.push(i);
  });
  const name = (i: number) => data.nodes[i].name ?? `node ${i}`;
  const walk = (parent: number | undefined, prefix: string) => {
    const siblings = children.get(parent) ?? [];
    siblings.forEach((i, k) => {
      const repeated = siblings.some((j) => j !== i && name(j) === name(i));
      out[i] =
        prefix + (repeated || name(i).startsWith('#') ? `#${k}` : name(i));
      walk(i, `${out[i]}/`);
    });
  };
  walk(undefined, '');
  scenePathCache.set(data, (list = out));
  return list;
}

type UnknownSchema = { data: 'ref' };
const unknowns = new WeakMap<World, Component<UnknownSchema>>();

/**
 * The component keeping the data of the components read without a codec
 * (`unknown components`): written again as they were.
 */
export function unknownComponents(scene: Scene): Component<UnknownSchema> {
  let component = unknowns.get(scene.world);
  if (!component) {
    component = scene.world.defineComponent('unknown components', {
      data: 'ref',
    });
    unknowns.set(scene.world, component);
  }
  return component;
}

/** The components of an entity read without a codec, by name. */
export function unknownComponentsOf(
  scene: Scene,
  entity: number,
): Record<string, ComponentData> | undefined {
  const component = unknowns.get(scene.world);
  return component?.has(entity)
    ? (component.data[entity] as Record<string, ComponentData>)
    : undefined;
}
