import type { Material, Mesh } from '@fdw/engine-core';
import type {
  ResourceStore,
  ResourceType,
  ServiceKey,
} from '@fdw/engine-resources';
import type {
  Component,
  ComponentStore,
  ComponentValues,
  FieldSchema,
  Scene,
  Schema,
} from '@fdw/engine-scene';
import type { ResourceRef } from './data';

/** What a codec writes with: references to resources and to entities. */
export interface WriteContext {
  readonly scene: Scene;
  readonly store?: ResourceStore;
  /**
   * The reference to a value of the store (ResourceStore.identify): its
   * URI, relative to the scene written. Undefined when the store did not
   * make it.
   */
  resource(value: object): ResourceRef | undefined;
  /** A mesh: by its URI, or written with the scene (`#mesh/n`). */
  mesh(mesh: Mesh): ResourceRef | undefined;
  /** A material: by its URI, or written with the scene (`#material/n`). */
  material(material: Material): ResourceRef | undefined;
  /** The index of an entity in the scene written; undefined when it is not written. */
  indexOf(entity: number): number | undefined;
  warn(message: string): void;
}

/** What a codec reads with: resources loaded for the instance, entities by index. */
export interface ReadContext {
  readonly scene: Scene;
  readonly store?: ResourceStore;
  /** Loads a resource, kept until the instance is disposed. */
  load<T>(type: ResourceType<T>, ref: ResourceRef): Promise<T>;
  mesh(ref: ResourceRef): Promise<Mesh>;
  material(ref: ResourceRef): Promise<Material>;
  /** The entity made for an index of the scene read. */
  entity(index: number): number | undefined;
  /** A service of the store (the render backend). */
  service<S>(key: ServiceKey<S>): S | undefined;
  warn(message: string): void;
}

/**
 * How a component is saved and loaded, by the name of the component in
 * its world. `version` is written with the data; older data goes through
 * `migrate` first.
 */
export interface ComponentCodec<T = unknown> {
  readonly name: string;
  readonly version: number;
  /**
   * The codecs of a phase are read together, the phases in order: a codec
   * that needs the components of others (the levels of detail need the
   * renderers) reads later. 0 by default.
   */
  readonly phase?: number;
  /**
   * For the data kept outside the components of the world (the instances
   * of a behavior system): whether an entity has some. Without it, the
   * codec writes the entities that have the component of its name.
   */
  has?(entity: number): boolean;
  /** The data of an entity; undefined for nothing to write. */
  write(entity: number, ctx: WriteContext): T | undefined;
  read(data: T, entity: number, ctx: ReadContext): void | Promise<void>;
  /** Brings data of an older version to the current one. */
  migrate?(from: number, data: unknown): unknown;
}

const fieldSize = (field: FieldSchema) =>
  typeof field === 'string' ? 1 : field[1];
const fieldType = (field: FieldSchema) =>
  typeof field === 'string' ? field : field[0];

/** Whether a schema has numbers only: saved field by field without a codec. */
export const isNumeric = (schema: Schema): boolean =>
  Object.values(schema).every((field) => fieldType(field) !== 'ref');

/**
 * The codec of a component of numbers: its fields by name, a number or an
 * array each. Used for the components defined with `persist: true` that
 * have no codec.
 */
export function numericCodec(component: ComponentStore): ComponentCodec {
  const fields = Object.entries(component.schema);
  return {
    name: component.name,
    version: component.version,
    write(entity) {
      const columns = component as unknown as Record<string, ArrayLike<number>>;
      const data: Record<string, number | number[]> = {};
      for (const [name, field] of fields) {
        const size = fieldSize(field);
        const column = columns[name];
        data[name] =
          size === 1
            ? column[entity]
            : Array.from({ length: size }, (_, i) => column[entity * size + i]);
      }
      return data;
    },
    read(data, entity, ctx) {
      // The component of the world reading, not the one written.
      const target = ctx.scene.world.component(component.name) ?? component;
      ctx.scene.world.add(
        entity,
        target as Component,
        data as ComponentValues<Schema>,
      );
      ctx.scene.notify(entity, 'modified');
    },
  };
}

/**
 * The codecs of a capture or an instance, by component name. A component
 * with `persist: true` and no codec is saved field by field when it has
 * numbers only.
 */
export class SceneCodecs {
  private readonly _codecs = new Map<string, ComponentCodec<any>>();

  constructor(codecs: Iterable<ComponentCodec<any>> = []) {
    for (const codec of codecs) this.add(codec);
  }

  /** Adds a codec, replacing the one of the same name. */
  add(codec: ComponentCodec<any>): this {
    this._codecs.set(codec.name, codec);
    return this;
  }

  get(name: string): ComponentCodec | undefined {
    return this._codecs.get(name);
  }

  /** The codec writing a component: its own, or the numeric one if it persists. */
  writer(component: ComponentStore): ComponentCodec | undefined {
    const codec = this._codecs.get(component.name);
    if (codec) return codec;
    return component.persist && isNumeric(component.schema)
      ? numericCodec(component)
      : undefined;
  }

  /** The codecs of data kept outside the components of the world. */
  external(): ComponentCodec[] {
    return [...this._codecs.values()].filter((codec) => codec.has);
  }

  /** The codec reading data of a component name in a scene. */
  reader(scene: Scene, name: string): ComponentCodec | undefined {
    const codec = this._codecs.get(name);
    if (codec) return codec;
    const component = scene.world.component(name);
    return component?.persist && isNumeric(component.schema)
      ? numericCodec(component)
      : undefined;
  }

  /** A copy, with more codecs. */
  with(codecs: Iterable<ComponentCodec<any>>): SceneCodecs {
    const copy = new SceneCodecs(this._codecs.values());
    for (const codec of codecs) copy.add(codec);
    return copy;
  }
}
