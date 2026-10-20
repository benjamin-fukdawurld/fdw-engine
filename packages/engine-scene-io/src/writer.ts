import {
  textureOf,
  type GraphMaterialValue,
  type MaterialData,
  type MeshData,
} from '@fdw/engine-assets';
import type {
  GpuSampler,
  GpuSamplerConfiguration,
  GpuTexture,
} from '@fdw/engine-backend';
import {
  AllLayers,
  TransformLayout,
  type Material,
  type Mesh,
} from '@fdw/engine-core';
import {
  parseUri,
  relativePath,
  type ResourceStore,
} from '@fdw/engine-resources';
import { NodeFlags, type Scene } from '@fdw/engine-scene';
import type { SceneCodecs, WriteContext } from './codec';
import {
  SceneDataType,
  type ComponentData,
  type NodeFields,
  type ResourceRef,
} from './data';
import { unknownComponentsOf } from './members';

// What writes the nodes of a scene: their fields, their components by
// their codecs, the references to the resources (by URI, or written with
// the scene). Used by captureScene, and by the instances of scenes for
// what their nodes were made with.

const { stride, position: P, rotation: R, scale: S } = TransformLayout;

/** The components written by the structure itself, never by a codec. */
export const structuralComponents = new Set([
  'hierarchy',
  'node state',
  'model instance',
  'scene instance',
  'unknown components',
]);

/** The fields of a node, in the order they are compared. */
export const nodeKeys = [
  'position',
  'rotation',
  'scale',
  'visible',
  'static',
  'occluder',
  'layers',
] as const;

/** The value of the fields of a node not written. */
export const nodeDefaults = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  visible: true,
  static: false,
  occluder: false,
  layers: AllLayers,
} as const;

const near = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/** Whether two JSON-like values are equal, numbers within a rounding. */
export function sameData(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return near(a, b);
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (ArrayBuffer.isView(a) || Array.isArray(a)) {
    const x = a as ArrayLike<unknown>;
    const y = b as ArrayLike<unknown>;
    if (!(ArrayBuffer.isView(b) || Array.isArray(b)) || x.length !== y.length)
      return false;
    for (let i = 0; i < x.length; i++) if (!sameData(x[i], y[i])) return false;
    return true;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (
      !sameData(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    )
      return false;
  }
  return true;
}

/** The object without its undefined fields. */
export function clean<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * The fields of `have` that differ from `want` (the defaults for those
 * left out), and its components that differ: what an override writes.
 */
export function diffFields(
  have: NodeFields,
  want: NodeFields,
): Omit<NodeFields, 'name'> | undefined {
  const diff: Record<string, unknown> = {};
  for (const key of nodeKeys) {
    const value = have[key] ?? nodeDefaults[key];
    if (!sameData(value, want[key] ?? nodeDefaults[key])) diff[key] = value;
  }
  const changed: Record<string, ComponentData> = {};
  for (const [name, value] of Object.entries(have.components ?? {}))
    if (!sameData(value, want.components?.[name])) changed[name] = value;
  if (Object.keys(changed).length > 0) diff['components'] = changed;
  return Object.keys(diff).length > 0 ? diff : undefined;
}

const samplerKeys: readonly (keyof GpuSamplerConfiguration)[] = [
  'compare',
  'wrapModeS',
  'wrapModeT',
  'wrapModeR',
  'minFilter',
  'magFilter',
  'mipmapFilter',
  'maxAnisotropy',
];

const isTexture = (value: object): value is GpuTexture =>
  'format' in value && 'dimensions' in value;
const isBuffer = (value: object) => 'usage' in value && 'write' in value;

export interface SceneWriterOptions {
  readonly store?: ResourceStore;
  readonly codecs: SceneCodecs;
  /** The URI written at: the references are relative to it. */
  readonly uri?: string;
  /**
   * The canonical URIs of the store, the meshes and materials of a scene
   * file by reference too: what the nodes of an instance of a scene were
   * made with, to compare.
   */
  readonly absolute?: boolean;
  readonly indexOf?: (entity: number) => number | undefined;
  readonly warn: (message: string) => void;
}

/** Writes nodes, their components, and the meshes and materials made in code. */
export class SceneWriter {
  readonly meshes: MeshData[] = [];
  readonly materials: MaterialData[] = [];
  readonly context: WriteContext;
  private readonly _meshIndex = new Map<Mesh, number>();
  private readonly _materialIndex = new Map<Material, number>();
  private readonly _external;

  constructor(
    readonly scene: Scene,
    private readonly _options: SceneWriterOptions,
  ) {
    this._external = _options.codecs.external();
    this.context = {
      scene,
      store: _options.store,
      resource: (value) => this.resource(value),
      mesh: (mesh) => this.mesh(mesh),
      material: (material) => this.material(material),
      indexOf: (entity) => _options.indexOf?.(entity),
      warn: (message) => this._options.warn(message),
    };
  }

  /** The reference to a value of the store, if it made it. */
  resource(value: object): ResourceRef | undefined {
    const { store, absolute } = this._options;
    const identity = store?.identify(value);
    if (!identity || (!absolute && this.ofScene(identity.uri)))
      return undefined;
    const uri = absolute ? identity.uri : this.relative(identity.uri);
    const { options } = identity;
    return options === undefined ||
      (typeof options === 'object' &&
        options !== null &&
        Object.keys(options).length === 0)
      ? uri
      : { uri, options };
  }

  mesh(mesh: Mesh): ResourceRef {
    const ref = this.resource(mesh);
    if (ref !== undefined) return ref;
    let i = this._meshIndex.get(mesh);
    if (i === undefined) {
      i = this.meshes.length;
      this._meshIndex.set(mesh, i);
      // A loaded mesh is labelled by its URI when it has no name.
      const label =
        mesh.label === this._options.store?.identify(mesh)?.uri
          ? undefined
          : mesh.label;
      this.meshes.push({
        name: label,
        description: mesh.description,
        vertices: mesh.vertices,
        indices: mesh.indices,
      });
    }
    return `#mesh/${i}`;
  }

  material(material: Material): ResourceRef {
    const ref = this.resource(material);
    if (ref !== undefined) return ref;
    let i = this._materialIndex.get(material);
    if (i === undefined) {
      i = this.materials.length;
      this._materialIndex.set(material, i);
      this.materials.push(this.graphMaterial(material));
    }
    return `#material/${i}`;
  }

  /** The components of an entity written by the codecs, by name. */
  components(
    entity: number,
    skip?: ReadonlySet<string>,
  ): Record<string, ComponentData> | undefined {
    const { scene } = this;
    const { world } = scene;
    const out: Record<string, ComponentData> = {
      ...unknownComponentsOf(scene, entity),
    };
    for (const component of world.components) {
      if (
        !component.has(entity) ||
        structuralComponents.has(component.name) ||
        skip?.has(component.name) ||
        world.component(component.name) !== component
      )
        continue;
      const codec = this._options.codecs.writer(component);
      if (!codec || codec.has) continue;
      const data = codec.write(entity, this.context);
      if (data !== undefined)
        out[codec.name] = { version: codec.version, data };
    }
    for (const codec of this._external) {
      if (skip?.has(codec.name) || !codec.has!(entity)) continue;
      const data = codec.write(entity, this.context);
      if (data !== undefined)
        out[codec.name] = { version: codec.version, data };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** The fields of the node of an entity, its components with them. */
  fields(entity: number, skip?: ReadonlySet<string>): NodeFields {
    const { NodeState, transforms } = this.scene;
    const d = transforms.data;
    const o = entity * stride;
    const flags = NodeState.flags[entity];
    const name = NodeState.label[entity] as string;
    const layers = NodeState.layers[entity];
    const position = [d[o + P], d[o + P + 1], d[o + P + 2]] as const;
    const rotation = [
      d[o + R],
      d[o + R + 1],
      d[o + R + 2],
      d[o + R + 3],
    ] as const;
    const scale = [d[o + S], d[o + S + 1], d[o + S + 2]] as const;
    return clean({
      name: name || undefined,
      position: sameData(position, nodeDefaults.position)
        ? undefined
        : position,
      rotation: sameData(rotation, nodeDefaults.rotation)
        ? undefined
        : rotation,
      scale: sameData(scale, nodeDefaults.scale) ? undefined : scale,
      visible: flags & NodeFlags.Hidden ? false : undefined,
      static: flags & NodeFlags.Static ? true : undefined,
      occluder: flags & NodeFlags.Occluder ? true : undefined,
      layers: layers !== AllLayers ? layers : undefined,
      components: this.components(entity, skip),
    });
  }

  // The meshes and materials of a scene file belong to it: written again
  // with the scene, not referenced.
  private ofScene(uri: string): boolean {
    const hash = uri.indexOf('#');
    if (hash < 0) return false;
    const handle = this._options.store?.peek(SceneDataType, uri.slice(0, hash));
    handle?.release();
    return handle !== undefined;
  }

  private relative(uri: string): string {
    const base = this._options.uri;
    if (base === undefined) return uri;
    const isScheme = () => true;
    const a = parseUri(base, isScheme);
    const b = parseUri(uri, isScheme);
    if (a.scheme !== b.scheme) return uri;
    const path = relativePath(a.path, b.path);
    return b.fragment !== undefined ? `${path}#${b.fragment}` : path;
  }

  // A material made in code, as data: its graph and its values.
  private graphMaterial(material: Material): MaterialData {
    const warn = this._options.warn;
    const values: Record<string, GraphMaterialValue> = {};
    for (const [name, value] of material.values) {
      if (typeof value === 'number' || typeof value === 'boolean') {
        values[name] = value;
      } else if ('length' in value && typeof value.length === 'number') {
        values[name] = Array.from(value as ArrayLike<number>);
      } else if (isTexture(value)) {
        const texture = textureOf(value);
        const ref = texture && this.resource(texture);
        if (ref === undefined) {
          warn(
            `material ${material.label ?? ''}: texture ${name} has no URI (define it in the store to save it)`,
          );
          continue;
        }
        const uri = typeof ref === 'string' ? ref : ref.uri;
        const options = (typeof ref === 'string' ? {} : ref.options) as {
          colorSpace?: 'srgb' | 'linear';
          mips?: 'generate' | 'none' | 'file';
        };
        values[name] = clean({
          texture: uri,
          colorSpace: options?.colorSpace,
          mips: options?.mips,
        });
      } else if (isBuffer(value)) {
        warn(`material ${material.label ?? ''}: buffer ${name} is not saved`);
      } else {
        const sampler = value as GpuSampler;
        const configuration: Record<string, unknown> = {};
        for (const key of samplerKeys)
          if (sampler[key] !== undefined) configuration[key] = sampler[key];
        values[name] = { sampler: configuration as GpuSamplerConfiguration };
      }
    }
    return clean({
      kind: 'graph' as const,
      name: material.label,
      graph: material.graph,
      values,
      features:
        Object.keys(material.features).length > 0
          ? material.features
          : undefined,
      renderState: material.renderState,
    });
  }
}
