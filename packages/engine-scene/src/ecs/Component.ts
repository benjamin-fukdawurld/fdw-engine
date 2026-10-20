// A component: data that entities can have, stored in columns. Each field
// of its schema is a column indexed by entity: a typed array for numbers
// (several values per entity for vectors and matrices), an array for
// references to objects.

/** The type of a field: a number type, or `ref` for a reference to an object. */
export type FieldType =
  'f32' | 'f64' | 'i8' | 'i16' | 'i32' | 'u8' | 'u16' | 'u32' | 'ref';

/** A field: a type, or a type and a number of values per entity (a vector). */
export type FieldSchema = FieldType | readonly [FieldType, number];

export type Schema = Readonly<Record<string, FieldSchema>>;

type TypeOf<F extends FieldSchema> = F extends readonly [infer T, number]
  ? T
  : F;

type ArrayFor<T> = T extends 'f32'
  ? Float32Array
  : T extends 'f64'
    ? Float64Array
    : T extends 'i8'
      ? Int8Array
      : T extends 'i16'
        ? Int16Array
        : T extends 'i32'
          ? Int32Array
          : T extends 'u8'
            ? Uint8Array
            : T extends 'u16'
              ? Uint16Array
              : T extends 'u32'
                ? Uint32Array
                : unknown[];

/** The columns of a schema, by field name. */
export type Columns<S extends Schema> = {
  readonly [K in keyof S]: ArrayFor<TypeOf<S[K]>>;
};

/** The values given to an entity when it receives a component. */
export type ComponentValues<S extends Schema> = {
  readonly [K in keyof S]?: S[K] extends readonly [FieldType, number]
    ? ArrayLike<number>
    : TypeOf<S[K]> extends 'ref'
      ? unknown
      : number;
};

/** How a component is defined, besides its fields. */
export interface ComponentOptions<S extends Schema> {
  /**
   * The values an entity receives with the component, for the fields not
   * given: zero (and undefined for references) otherwise.
   */
  readonly defaults?: ComponentValues<S>;
  /** The version of the schema, saved with the values. 1 by default. */
  readonly version?: number;
  /**
   * Whether the component is saved with the scene (@fdw/engine-scene-io):
   * by its codec, or field by field for a component of numbers. False by
   * default: the state of the systems is rebuilt, not saved.
   */
  readonly persist?: boolean;
}

type NumberArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

const constructors = {
  f32: Float32Array,
  f64: Float64Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
} as const;

interface Field {
  readonly name: string;
  readonly type: FieldType;
  // Values per entity.
  readonly size: number;
  column: NumberArray | unknown[];
}

/**
 * The data of a component in a World, and its entities. Its fields are
 * columns indexed by entity (`Velocity.x[entity]`); the columns are
 * replaced when the world grows: read them where they are used, rather than
 * keeping them.
 */
export class ComponentStore<S extends Schema = Schema> {
  readonly id: number;
  readonly name: string;
  readonly schema: S;
  readonly defaults?: ComponentValues<S>;
  readonly version: number;
  readonly persist: boolean;
  private readonly _fields: Field[];

  // The entities that have the component: a sparse set (dense list, and
  // the position of each entity in it, -1 for none).
  private _dense: Uint32Array;
  private _sparse: Int32Array;
  private _count = 0;

  /** @internal Created by World.defineComponent(). */
  constructor(
    id: number,
    name: string,
    schema: S,
    capacity: number,
    options: ComponentOptions<S> = {},
  ) {
    this.id = id;
    this.name = name;
    this.schema = schema;
    this.defaults = options.defaults;
    this.version = options.version ?? 1;
    this.persist = options.persist ?? false;
    this._fields = Object.entries(schema).map(([fieldName, field]) => {
      const [type, size] = typeof field === 'string' ? [field, 1] : field;
      return {
        name: fieldName,
        type,
        size,
        column: allocate(type, size * capacity),
      };
    });
    for (const field of this._fields) {
      Object.defineProperty(this, field.name, {
        get: () => field.column,
        enumerable: true,
      });
    }
    this._dense = new Uint32Array(Math.max(capacity, 1));
    this._sparse = new Int32Array(capacity).fill(-1);
  }

  /** The number of entities with the component. */
  get count(): number {
    return this._count;
  }

  /** The entities with the component, in no particular order. */
  get entities(): Uint32Array {
    return this._dense.subarray(0, this._count);
  }

  has(entity: number): boolean {
    return this._sparse[entity] >= 0;
  }

  /** @internal */
  insert(entity: number, values: ComponentValues<S> = {}): void {
    if (this._sparse[entity] >= 0) {
      this.write(entity, values);
      return;
    }
    if (this._count === this._dense.length) {
      const dense = new Uint32Array(this._dense.length * 2);
      dense.set(this._dense);
      this._dense = dense;
    }
    this._sparse[entity] = this._count;
    this._dense[this._count++] = entity;
    // Its values are zero: new columns are, and delete() clears them.
    if (this.defaults) {
      this.write(entity, this.defaults);
    }
    this.write(entity, values);
  }

  /**
   * @internal Inserts many entities with the same values, field after
   * field: the batch version of insert().
   */
  insertMany(
    entities: ArrayLike<number>,
    values: ComponentValues<S> = {},
  ): void {
    const needed = this._count + entities.length;
    if (needed > this._dense.length) {
      const dense = new Uint32Array(Math.max(this._dense.length * 2, needed));
      dense.set(this._dense);
      this._dense = dense;
    }
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (this._sparse[entity] < 0) {
        this._sparse[entity] = this._count;
        this._dense[this._count++] = entity;
        if (this.defaults) {
          this.write(entity, this.defaults);
        }
      }
    }
    for (const field of this._fields) {
      const value = (values as Record<string, unknown>)[field.name];
      if (value === undefined) {
        continue;
      }
      // One loop per kind of field: each stays monomorphic.
      if (field.type === 'ref') {
        const column = field.column as unknown[];
        for (let i = 0; i < entities.length; i++) {
          column[entities[i]] = value;
        }
      } else if (field.size === 1) {
        const column = field.column as NumberArray;
        const number = value as number;
        for (let i = 0; i < entities.length; i++) {
          column[entities[i]] = number;
        }
      } else {
        const column = field.column as NumberArray;
        const vector = value as ArrayLike<number>;
        for (let i = 0; i < entities.length; i++) {
          column.set(vector, entities[i] * field.size);
        }
      }
    }
  }

  /** @internal */
  delete(entity: number): void {
    const position = this._sparse[entity];
    if (position < 0) {
      return;
    }
    const last = this._dense[--this._count];
    this._dense[position] = last;
    this._sparse[last] = position;
    this._sparse[entity] = -1;
    this.clear(entity);
  }

  /** Writes values of an entity; the fields left out keep theirs. */
  write(entity: number, values: ComponentValues<S>): void {
    for (const field of this._fields) {
      const value = (values as Record<string, unknown>)[field.name];
      if (value === undefined) {
        continue;
      }
      if (field.type === 'ref') {
        (field.column as unknown[])[entity] = value;
      } else if (field.size === 1) {
        (field.column as NumberArray)[entity] = value as number;
      } else {
        (field.column as NumberArray).set(
          value as ArrayLike<number>,
          entity * field.size,
        );
      }
    }
  }

  // Zeroes the values of an entity (references to undefined).
  private clear(entity: number): void {
    for (const field of this._fields) {
      if (field.type === 'ref') {
        (field.column as unknown[])[entity] = undefined;
      } else {
        (field.column as NumberArray).fill(
          0,
          entity * field.size,
          (entity + 1) * field.size,
        );
      }
    }
  }

  /** @internal Grows the columns to a new number of entities. */
  grow(capacity: number): void {
    for (const field of this._fields) {
      if (field.type === 'ref') {
        continue;
      }
      const grown = allocate(field.type, field.size * capacity) as NumberArray;
      grown.set(field.column as NumberArray);
      field.column = grown;
    }
    const sparse = new Int32Array(capacity).fill(-1);
    sparse.set(this._sparse);
    this._sparse = sparse;
  }
}

function allocate(type: FieldType, length: number): NumberArray | unknown[] {
  return type === 'ref' ? [] : new constructors[type](length);
}

/** A component of a World: its store, with a column per field. */
export type Component<S extends Schema = Schema> = ComponentStore<S> &
  Columns<S>;
