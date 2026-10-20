import {
  instantiate,
  MaterialDataType,
  MaterialType,
  MeshDataType,
  MeshType,
  ModelType,
  modelInstanceOf,
  type ModelInstanceRecord,
} from '@fdw/engine-assets';
import { AllLayers, type Material, type Mesh } from '@fdw/engine-core';
import type {
  ResourceHandle,
  ResourceScope,
  ResourceStore,
  ResourceType,
} from '@fdw/engine-resources';
import type { Node, NodeOptions, Scene } from '@fdw/engine-scene';
import { SceneCodecs, type ComponentCodec, type ReadContext } from './codec';
import { sceneCodecs } from './codecs';
import {
  refOptions,
  refUri,
  type ComponentData,
  type NodeFields,
  SceneDataType,
  type ResourceRef,
  type SceneData,
} from './data';
import {
  isMember,
  resolveMember,
  sceneInstanceComponent,
  sceneInstanceOf,
  scenePaths,
  unknownComponents,
  type SceneInstanceRecord,
} from './members';
import { SceneWriter } from './writer';

export interface InstantiateSceneOptions extends NodeOptions {
  /** The store the resources of the scene are loaded from. */
  readonly store: ResourceStore;
  /** The parent of the instance: a node or an entity; the root of the scene by default. */
  readonly parent?: Node | number;
  /** The codecs of the components; those of engine-scene by default. */
  readonly codecs?: SceneCodecs | Iterable<ComponentCodec<any>>;
  /** The URI of the scene, for its relative references: that of the handle by default. */
  readonly uri?: string;
  /**
   * Whether the nodes go under a new node holding the instance (true, the
   * default), or straight under the parent: the nodes following their
   * physics bodies must be under the root of the scene.
   */
  readonly wrap?: boolean;
  /** Cancels the loading of the resources: the nodes made are removed. */
  readonly signal?: AbortSignal;
  /** Receives what could not be read. console.warn by default. */
  readonly warn?: (message: string) => void;
}

/** The nodes made from a scene. */
export interface SceneInstance {
  /** The node holding the instance (move it to move the scene); the parent with `wrap: false`. */
  readonly root: Node;
  /** The entity made for each index of the scene data (its nodes, then its batches). */
  readonly entities: readonly number[];
  /** Destroys the nodes and releases the resources of the instance. */
  dispose(): void;
}

let memoryScenes = 0;

/**
 * Makes the nodes of a scene: its nodes and batches, its instances of
 * models with their changes, then the components by their codecs, phase
 * after phase. The resources are loaded by the store and kept until
 * `dispose()`. A scene in memory (captured, not loaded) has its meshes and
 * materials defined in the store for the time of the instance.
 */
export async function instantiateScene(
  source: SceneData | ResourceHandle<SceneData>,
  scene: Scene,
  options: InstantiateSceneOptions,
): Promise<SceneInstance> {
  const {
    store,
    parent,
    codecs: codecOption,
    uri: uriOption,
    wrap = true,
    signal,
    warn: warnOption,
    ...nodeOptions
  } = options;
  const warn = warnOption ?? ((m: string) => console.warn(`[scene-io] ${m}`));
  const codecs =
    codecOption instanceof SceneCodecs
      ? codecOption
      : new SceneCodecs(codecOption ?? sceneCodecs);
  const handle = 'ready' in source ? source.clone() : undefined;
  const scope = store.scope('scene instance');
  if (handle) scope.adopt(handle);
  const parentEntity =
    parent === undefined
      ? scene.root.entity
      : typeof parent === 'number'
        ? parent
        : parent.entity;
  let root: Node | undefined;
  // Without a node of its own, the top nodes made are removed one by one.
  const tops: number[] = [];
  // The instances of scenes made inside: their resources are theirs.
  const nested: SceneInstance[] = [];
  const dispose = () => {
    if (wrap) {
      if (root?.alive) scene.destroy(root.entity);
    } else {
      for (const entity of tops)
        if (scene.world.isAlive(entity)) scene.destroy(entity);
    }
    for (const instance of nested) instance.dispose();
    scope.dispose();
  };

  try {
    const data = handle ? await handle.ready : (source as SceneData);
    const uri = uriOption ?? handle?.uri ?? defineMemory(store, scope, data);
    const entities: number[] = [];
    const ctx = readContext(scene, store, scope, uri, entities, warn, signal);

    // The models and scenes of the instances, loaded together.
    const models = await Promise.all(
      data.nodes.map((node) =>
        node.instance?.model !== undefined
          ? ctx.load(ModelType, node.instance.model)
          : undefined,
      ),
    );
    const scenes = data.nodes.map((node) =>
      node.instance?.scene !== undefined
        ? scope.load(
            SceneDataType,
            store.resolve(uri, refUri(node.instance.scene)),
            {
              signal,
            },
          )
        : undefined,
    );
    await Promise.all(scenes.map((handle) => handle?.ready));
    signal?.throwIfAborted();

    root = wrap
      ? scene.node(
          scene.create(parentEntity, {
            name: data.name ?? 'scene',
            ...nodeOptions,
          }),
        )
      : scene.node(parentEntity);
    const rootEntity = root.entity;
    entities.length = data.nodes.length;
    const records = new Map<number, ModelInstanceRecord>();
    const sceneRecords = new Map<number, SceneInstanceRecord>();
    const member = (i: number, path: string): number | undefined => {
      const model = records.get(i);
      if (model) return resolveMember(scene, model, path);
      const record = sceneRecords.get(i);
      if (!record) return undefined;
      const index = scenePaths(record.data).indexOf(path);
      const entity = index >= 0 ? record.nodes[index] : undefined;
      return entity !== undefined && isMember(scene, record.members, entity)
        ? entity
        : undefined;
    };
    // In order: the parents come first, and a child is linked after its
    // elder siblings.
    for (let i = 0; i < data.nodes.length; i++) {
      const node = data.nodes[i];
      let at = node.parent === undefined ? rootEntity : entities[node.parent];
      if (node.parentPath !== undefined && node.parent !== undefined) {
        const found = member(node.parent, node.parentPath);
        if (found === undefined)
          warn(`node ${i}: no ${node.parentPath} in its instance, added to it`);
        at = found ?? at;
      }
      const model = models[i];
      const sub = scenes[i];
      if (sub) {
        const instance = await instantiateScene(sub, scene, {
          store,
          codecs,
          parent: at,
          name: node.name,
          signal,
          warn,
        });
        nested.push(instance);
        entities[i] = instance.root.entity;
        sceneRecords.set(i, sceneInstanceOf(scene, entities[i])!);
      } else if (model) {
        const instance = instantiate(model, scene, {
          parent: at,
          castShadow: node.instance?.castShadow,
          lights: node.instance?.lights,
          name: node.name,
        });
        entities[i] = instance.root.entity;
        records.set(i, modelInstanceOf(scene, entities[i])!);
      } else {
        entities[i] = scene.create(at, { name: node.name });
      }
      applyFields(scene, entities[i], node);
      if (node.parent === undefined) tops.push(entities[i]);
    }

    // The batches, after the nodes: their parents are there.
    const batchEntities: Uint32Array[] = [];
    const meshesOf = await Promise.all(
      data.batches.map((batch) =>
        batch.mesh !== undefined && batch.material !== undefined
          ? Promise.all([ctx.mesh(batch.mesh), ctx.material(batch.material)])
          : undefined,
      ),
    );
    signal?.throwIfAborted();
    for (let b = 0; b < data.batches.length; b++) {
      const batch = data.batches[b];
      const drawn = meshesOf[b];
      const made = scene.createBatch({
        count: batch.count,
        parent:
          batch.parent === undefined ? rootEntity : entities[batch.parent],
        positions: batch.positions,
        rotations: batch.rotations,
        scales: batch.scales,
        mesh: drawn?.[0],
        material: drawn?.[1],
        castShadow: batch.castShadow,
        name: batch.name,
        layers: batch.layers,
        visible: batch.visible,
        static: batch.static,
        occluder: batch.occluder,
      });
      batchEntities[b] = made;
      if (batch.parent === undefined) tops.push(...made);
    }
    for (const list of batchEntities) entities.push(...list);

    // What to read: the components of the nodes, of the batches, of the
    // changes of the instances.
    const reads: { entity: number; name: string; value: ComponentData }[] = [];
    const add = (entity: number, components: NodeFields['components']) => {
      for (const [name, value] of Object.entries(components ?? {}))
        if (value) reads.push({ entity, name, value });
    };
    data.nodes.forEach((node, i) => add(entities[i], node.components));
    data.batches.forEach((batch, b) => {
      for (const [name, column] of Object.entries(batch.components ?? {})) {
        column.data.forEach((value, k) => {
          if (value !== null && value !== undefined)
            reads.push({
              entity: batchEntities[b][k],
              name,
              value: { version: column.version, data: value },
            });
        });
      }
    });
    data.nodes.forEach((node, i) => {
      for (const override of node.instance?.overrides ?? []) {
        const target = member(i, override.path);
        if (target === undefined) {
          warn(`instance ${i}: no ${override.path} to change`);
          continue;
        }
        if (override.removed) {
          scene.destroy(target);
          continue;
        }
        applyFields(scene, target, override);
        add(target, override.components);
      }
    });
    await readComponents(reads, codecs, ctx, warn);
    signal?.throwIfAborted();
    const instance = { root, entities, dispose };
    // Loaded by the store, the scene is known by its URI: its instance is
    // written as a reference.
    if (handle && wrap) recordScene(scene, instance, data, store, codecs);
    return instance;
  } catch (e) {
    dispose();
    throw e;
  }
}

// What an instance of a scene was made with, on its root: its nodes, every
// entity made, the fields of its nodes (to write their changes).
function recordScene(
  scene: Scene,
  instance: SceneInstance,
  data: SceneData,
  store: ResourceStore,
  codecs: SceneCodecs,
): SceneInstanceRecord {
  const members = new Map<number, number>();
  const walk = (entity: number) => {
    for (
      let c = scene.Hierarchy.first[entity];
      c !== -1;
      c = scene.Hierarchy.next[c]
    ) {
      members.set(c, scene.world.generation(c));
      walk(c);
    }
  };
  walk(instance.root.entity);
  const nodes = instance.entities.slice(0, data.nodes.length);
  const writer = new SceneWriter(scene, {
    store,
    codecs,
    absolute: true,
    warn: () => undefined,
  });
  const record: SceneInstanceRecord = {
    data,
    nodes,
    members,
    baseline: nodes.map((entity) => writer.fields(entity)),
  };
  scene.world.add(instance.root.entity, sceneInstanceComponent(scene), {
    record,
  });
  return record;
}

/** Reads components, the phases in order, the codecs of a phase together. */
async function readComponents(
  reads: readonly { entity: number; name: string; value: ComponentData }[],
  codecs: SceneCodecs,
  ctx: ReadContext,
  warn: (message: string) => void,
): Promise<void> {
  const phases = new Map<number, (() => void | Promise<void>)[]>();
  for (const { entity, name, value } of reads) {
    const codec = codecs.reader(ctx.scene, name);
    let data = value.data;
    if (codec && value.version < codec.version) {
      if (codec.migrate) {
        data = codec.migrate(value.version, data);
      } else {
        warn(`${name}: no migration from version ${value.version}`);
        keepUnknown(ctx.scene, entity, name, value);
        continue;
      }
    }
    if (!codec || value.version > codec.version) {
      if (codec)
        warn(
          `${name}: version ${value.version} is newer than ${codec.version}`,
        );
      keepUnknown(ctx.scene, entity, name, value);
      continue;
    }
    const phase = codec.phase ?? 0;
    let list = phases.get(phase);
    if (!list) phases.set(phase, (list = []));
    list.push(() => codec.read(data, entity, ctx));
  }
  for (const phase of [...phases.keys()].sort((a, b) => a - b)) {
    await Promise.all(phases.get(phase)!.map((read) => read()));
  }
}

// The data of a component without its codec, kept on the entity.
function keepUnknown(
  scene: Scene,
  entity: number,
  name: string,
  value: ComponentData,
): void {
  const Unknown = unknownComponents(scene);
  const kept = Unknown.has(entity)
    ? (Unknown.data[entity] as Record<string, ComponentData>)
    : {};
  scene.world.add(entity, Unknown, { data: { ...kept, [name]: value } });
}

/** Writes the fields of a node data on an entity. */
export function applyFields(
  scene: Scene,
  entity: number,
  fields: NodeFields,
): void {
  const { position, rotation, scale } = fields;
  if (position || rotation || scale) {
    const transform = scene.node(entity).transform;
    if (position)
      transform.position = { x: position[0], y: position[1], z: position[2] };
    if (rotation)
      transform.rotation = {
        x: rotation[0],
        y: rotation[1],
        z: rotation[2],
        w: rotation[3],
      };
    if (scale) transform.scale = { x: scale[0], y: scale[1], z: scale[2] };
  }
  if (
    fields.visible !== undefined ||
    fields.static !== undefined ||
    fields.occluder !== undefined ||
    fields.layers !== undefined
  ) {
    const node = scene.node(entity);
    if (fields.visible !== undefined) node.visible = fields.visible;
    if (fields.static !== undefined) node.static = fields.static;
    if (fields.occluder !== undefined) node.occluder = fields.occluder;
    if (fields.layers !== undefined) node.layers = fields.layers ?? AllLayers;
  }
}

// A scene in memory: its meshes and materials defined in the store under a
// URI of its own, for the time of the instance.
function defineMemory(
  store: ResourceStore,
  scope: ResourceScope,
  data: SceneData,
): string {
  const uri = `scene-io/memory-${++memoryScenes}.scene`;
  scope.adopt(store.define(SceneDataType, uri, data));
  data.meshes.forEach((mesh, i) =>
    scope.adopt(store.define(MeshDataType, `${uri}#mesh/${i}`, mesh)),
  );
  data.materials.forEach((material, i) =>
    scope.adopt(
      store.define(MaterialDataType, `${uri}#material/${i}`, material),
    ),
  );
  return uri;
}

function readContext(
  scene: Scene,
  store: ResourceStore,
  scope: ResourceScope,
  uri: string,
  entities: readonly number[],
  warn: (message: string) => void,
  signal: AbortSignal | undefined,
): ReadContext {
  const load = async <T>(type: ResourceType<T>, ref: ResourceRef) => {
    const handle = scope.load(type, store.resolve(uri, refUri(ref)), {
      options: refOptions(ref),
      signal,
    });
    return handle.ready;
  };
  const ctx: ReadContext = {
    scene,
    store,
    load,
    mesh: (ref) => load<Mesh>(MeshType, ref),
    material: (ref) => load<Material>(MaterialType, ref),
    entity: (index) => entities[index],
    service: (key) => store.service(key),
    warn,
  };
  return ctx;
}
