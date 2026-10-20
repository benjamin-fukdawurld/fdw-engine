import {
  DirectionalLight,
  PointLight,
  SpotLight,
  type BaseLight,
} from '@fdw/engine-core';
import type { ResourceHandle } from '@fdw/engine-resources';
import type {
  Component,
  Node,
  NodeOptions,
  Scene,
  World,
} from '@fdw/engine-scene';
import type { LightData } from './data';
import type { Model } from './models';

export interface InstantiateOptions extends NodeOptions {
  /** The parent of the instance: a node or an entity; the root of the scene by default. */
  readonly parent?: Node | number;
  /** Whether the meshes cast shadows. True by default. */
  readonly castShadow?: boolean;
  /** Whether the lights of the model (`KHR_lights_punctual`) are added. True by default. */
  readonly lights?: boolean;
}

/** The nodes made from a model. */
export interface ModelInstance {
  /** The node holding the instance: move it to move the model. */
  readonly root: Node;
  /** The nodes of the model, in the order of its data (`model.data.nodes`). */
  readonly nodes: readonly Node[];
  /** Makes the nodes again from the current model (after a reload that changed its hierarchy). */
  rebuild(): void;
  /** Destroys the nodes, and releases the handle of the model if it was given one. */
  dispose(): void;
}

/**
 * What the root of an instance remembers (component `model instance`): its
 * model, how it was made, and the entities made from the model under it
 * (the others were added after). A saved scene writes the instance as its
 * model and the changes made to these entities.
 */
export interface ModelInstanceRecord {
  readonly model: Model;
  readonly castShadow: boolean;
  readonly lights: boolean;
  /** The entities made from the model, by index of its data (`model.data.nodes`). */
  readonly nodes: readonly number[];
  /**
   * Every entity made from the model (its nodes, and the children holding
   * their primitives), with its generation: an entity destroyed then
   * reused is no longer a member (see isInstanceMember).
   */
  readonly members: ReadonlyMap<number, number>;
}

/** Whether an entity is one made by an instance, still alive. */
export function isInstanceMember(
  scene: Scene,
  record: ModelInstanceRecord,
  entity: number,
): boolean {
  return (
    scene.world.isAlive(entity) &&
    record.members.get(entity) === scene.world.generation(entity)
  );
}

type InstanceSchema = { record: 'ref' };
const components = new WeakMap<World, Component<InstanceSchema>>();

/** The component of the roots of the model instances of a scene: `record`, a ModelInstanceRecord. */
export function modelInstanceComponent(
  scene: Scene,
): Component<InstanceSchema> {
  let component = components.get(scene.world);
  if (!component) {
    component = scene.world.defineComponent('model instance', {
      record: 'ref',
    });
    components.set(scene.world, component);
  }
  return component;
}

/** The record of the instance whose root is `entity`, if it is one. */
export function modelInstanceOf(
  scene: Scene,
  entity: number,
): ModelInstanceRecord | undefined {
  const component = components.get(scene.world);
  return component?.has(entity)
    ? (component.record[entity] as ModelInstanceRecord)
    : undefined;
}

const degrees = (radians: number) => (radians * 180) / Math.PI;

/** An engine light from the data of `KHR_lights_punctual`, placed by its node. */
export function createLight(data: LightData): BaseLight {
  const [r, g, b] = data.color.map((c) => c * data.intensity);
  const colors = {
    ambient: { x: 0, y: 0, z: 0 },
    diffuse: { x: r, y: g, z: b },
    specular: { x: r, y: g, z: b },
  };
  // Inverse square, as in glTF.
  const attenuation = {
    constantAttenuation: 1,
    linearAttenuation: 0,
    quadraticAttenuation: 1,
  };
  switch (data.type) {
    case 'directional':
      return new DirectionalLight({
        ...colors,
        direction: { x: 0, y: 0, z: -1 },
      });
    case 'point':
      return new PointLight({ ...colors, ...attenuation });
    case 'spot':
      return new SpotLight({
        ...colors,
        ...attenuation,
        direction: { x: 0, y: 0, z: -1 },
        innerCutoff: degrees(data.innerConeAngle ?? 0),
        outerCutoff: degrees(data.outerConeAngle ?? Math.PI / 4),
      });
  }
}

/**
 * Makes the nodes of a model in a scene, under a new node. The nodes share
 * the meshes and materials of the model: ten instances of a tree are drawn
 * in one call per primitive by the instancing. Given a handle, the instance
 * keeps the model alive (its own handle) until `dispose()`.
 */
export function instantiate(
  model: Model | ResourceHandle<Model>,
  scene: Scene,
  options: InstantiateOptions = {},
): ModelInstance {
  const handle = 'require' in model ? model.clone() : undefined;
  const target = (): Model => (handle ? handle.require() : (model as Model));
  const { parent, castShadow = true, lights = true, ...nodeOptions } = options;
  const parentEntity =
    parent === undefined
      ? scene.root.entity
      : typeof parent === 'number'
        ? parent
        : parent.entity;
  const root = scene.node(
    scene.create(parentEntity, {
      name: target().data.name ?? 'model',
      ...nodeOptions,
    }),
  );
  let nodes: Node[] = [];

  const build = () => {
    const model = target();
    const { data, meshes } = model;
    nodes = new Array(data.nodes.length);
    const members = new Map<number, number>();
    const member = (entity: number) =>
      members.set(entity, scene.world.generation(entity));
    const make = (index: number, parentNode: Node) => {
      const n = data.nodes[index];
      const node = scene.node(
        scene.create(parentNode.entity, {
          name: n.name ?? `node ${index}`,
          position: n.translation && {
            x: n.translation[0],
            y: n.translation[1],
            z: n.translation[2],
          },
          rotation: n.rotation && {
            x: n.rotation[0],
            y: n.rotation[1],
            z: n.rotation[2],
            w: n.rotation[3],
          },
          scale: n.scale && { x: n.scale[0], y: n.scale[1], z: n.scale[2] },
        }),
      );
      nodes[index] = node;
      member(node.entity);
      const primitives = n.mesh !== undefined ? (meshes[n.mesh] ?? []) : [];
      if (primitives.length === 1) {
        node.setMesh(primitives[0].mesh, primitives[0].material, {
          castShadow,
        });
      } else {
        primitives.forEach(({ mesh, material }, i) =>
          member(
            node
              .add({ name: `${node.name}#${i}` })
              .setMesh(mesh, material, { castShadow }).entity,
          ),
        );
      }
      if (lights && n.light !== undefined && data.lights[n.light])
        node.setLight(createLight(data.lights[n.light]));
      for (const child of n.children) make(child, node);
    };
    for (const index of data.roots) make(index, root);
    const record: ModelInstanceRecord = {
      model,
      castShadow,
      lights,
      nodes: nodes.map((node) => node.entity),
      members,
    };
    root.attach(modelInstanceComponent(scene), { record });
  };
  build();

  return {
    root,
    get nodes() {
      return nodes;
    },
    rebuild() {
      for (const child of [...root.children]) scene.destroy(child.entity);
      build();
    },
    dispose() {
      if (root.alive) scene.destroy(root.entity);
      handle?.release();
    },
  };
}
