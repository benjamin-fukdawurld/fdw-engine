import type {
  CharacterDesc,
  ColliderDesc,
  CombineRule,
  NodeBodyDesc,
  PhysicsBodyData,
  PhysicsMaterial,
  Shape,
} from '@fdw/engine-physics';
import type { Trs } from '../nodes';

// The bodies of KHR_physics_rigid_bodies and the shapes of
// KHR_implicit_shapes, to the descriptions of @fdw/engine-physics and back.
// A body is on the node with `motion`, its colliders on it and on its
// descendants; a collider without motion above it is a static body of its
// own. The shapes of the engine are not scaled by the nodes: the scale of
// the nodes is baked into their sizes.

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

export interface GltfImplicitShape {
  readonly type: string;
  readonly sphere?: { readonly radius?: number };
  readonly box?: { readonly size?: Vec3 };
  readonly capsule?: {
    readonly height?: number;
    readonly radiusTop?: number;
    readonly radiusBottom?: number;
  };
  readonly cylinder?: {
    readonly height?: number;
    readonly radiusTop?: number;
    readonly radiusBottom?: number;
  };
  readonly plane?: {
    readonly sizeX?: number;
    readonly sizeZ?: number;
    readonly doubleSided?: boolean;
  };
}

export interface GltfGeometry {
  readonly shape?: number;
  readonly mesh?: number;
  readonly convexHull?: boolean;
}

export interface GltfCollider {
  readonly geometry?: GltfGeometry;
  /** The draft of the extension: the shape without `geometry`. */
  readonly shape?: number;
  readonly physicsMaterial?: number;
  readonly collisionFilter?: number;
}

export interface GltfPhysicsNode {
  readonly motion?: {
    readonly isKinematic?: boolean;
    readonly mass?: number;
    readonly linearVelocity?: Vec3;
    readonly angularVelocity?: Vec3;
    readonly gravityFactor?: number;
  };
  readonly collider?: GltfCollider;
  readonly trigger?: GltfCollider & { readonly nodes?: readonly number[] };
}

type GltfCombine = 'average' | 'minimum' | 'maximum' | 'multiply';

export interface GltfPhysicsMaterial {
  readonly staticFriction?: number;
  readonly dynamicFriction?: number;
  readonly restitution?: number;
  readonly frictionCombine?: GltfCombine;
  readonly restitutionCombine?: GltfCombine;
}

export interface GltfCollisionFilter {
  readonly collisionSystems?: readonly string[];
  readonly collideWithSystems?: readonly string[];
  readonly notCollideWithSystems?: readonly string[];
}

export interface GltfPhysicsRoot {
  readonly physicsMaterials?: readonly GltfPhysicsMaterial[];
  readonly collisionFilters?: readonly GltfCollisionFilter[];
}

const combines: Record<GltfCombine, CombineRule> = {
  average: 'average',
  minimum: 'min',
  maximum: 'max',
  multiply: 'multiply',
};
const gltfCombines: Record<CombineRule, GltfCombine> = {
  average: 'average',
  min: 'minimum',
  max: 'maximum',
  multiply: 'multiply',
};

// --- Transforms ----------------------------------------------------------------

const rotate = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};

const multiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** `child` in the space of `parent`: the transform of the child after its parent's. */
export function composeTrs(parent: Trs, child: Trs): Trs {
  const scaled: Vec3 = [
    parent.scale[0] * child.translation[0],
    parent.scale[1] * child.translation[1],
    parent.scale[2] * child.translation[2],
  ];
  const moved = rotate(parent.rotation, scaled);
  return {
    translation: [
      parent.translation[0] + moved[0],
      parent.translation[1] + moved[1],
      parent.translation[2] + moved[2],
    ],
    rotation: multiply(parent.rotation, child.rotation),
    scale: [
      parent.scale[0] * child.scale[0],
      parent.scale[1] * child.scale[1],
      parent.scale[2] * child.scale[2],
    ],
  };
}

export const identityTrs: Trs = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

// --- Shapes ----------------------------------------------------------------------

/** A shape of KHR_implicit_shapes in the engine, its node's scale baked in. */
export function implicitShape(
  shape: GltfImplicitShape,
  scale: Vec3,
  warn: (message: string) => void,
): Shape | undefined {
  const [sx, sy, sz] = scale.map(Math.abs);
  switch (shape.type) {
    case 'sphere':
      return {
        type: 'sphere',
        radius: (shape.sphere?.radius ?? 0.5) * Math.max(sx, sy, sz),
      };
    case 'box': {
      const [x, y, z] = shape.box?.size ?? [1, 1, 1];
      return {
        type: 'box',
        halfExtents: { x: (x / 2) * sx, y: (y / 2) * sy, z: (z / 2) * sz },
      };
    }
    case 'capsule':
    case 'cylinder': {
      const params = shape[shape.type] ?? {};
      const top = params.radiusTop ?? 0.25;
      const bottom = params.radiusBottom ?? 0.25;
      if (top !== bottom)
        warn(`a ${shape.type} of two radii: the larger one is kept`);
      return {
        type: shape.type,
        halfHeight: ((params.height ?? 0.5) / 2) * sy,
        radius: Math.max(top, bottom) * Math.max(sx, sz),
      };
    }
    case 'plane': {
      // A plane of the engine is a thin box: infinite planes get 1 km.
      const x = (shape.plane?.sizeX ?? 1000) / 2;
      const z = (shape.plane?.sizeZ ?? 1000) / 2;
      return {
        type: 'box',
        halfExtents: { x: x * sx, y: 0.005, z: z * sz },
      };
    }
    default:
      warn(`the shape type ${shape.type} is not supported`);
      return undefined;
  }
}

/** A shape of the engine in KHR_implicit_shapes; undefined for the meshes. */
export function gltfImplicitShape(shape: Shape): GltfImplicitShape | undefined {
  switch (shape.type) {
    case 'sphere':
      return { type: 'sphere', sphere: { radius: shape.radius } };
    case 'box': {
      const { x, y, z } = shape.halfExtents;
      return { type: 'box', box: { size: [x * 2, y * 2, z * 2] } };
    }
    case 'capsule':
    case 'cylinder':
      return {
        type: shape.type,
        [shape.type]: {
          height: shape.halfHeight * 2,
          radiusTop: shape.radius,
          radiusBottom: shape.radius,
        },
      };
    default:
      return undefined;
  }
}

/** The triangles of a heightfield, centered as the engine places it. */
export function heightfieldMesh(shape: Shape & { type: 'heightfield' }): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const { rows, columns, heights, size } = shape;
  const vertices = new Float32Array(rows * columns * 3);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      vertices[i * 3] = (c / (columns - 1) - 0.5) * size.x;
      vertices[i * 3 + 1] = heights[i] * size.y;
      vertices[i * 3 + 2] = (r / (rows - 1) - 0.5) * size.z;
    }
  const indices = new Uint32Array((rows - 1) * (columns - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < columns - 1; c++) {
      const a = r * columns + c;
      const b = a + 1;
      const d = a + columns;
      const e = d + 1;
      indices.set([a, d, b, b, d, e], k);
      k += 6;
    }
  return { vertices, indices };
}

// --- Import ------------------------------------------------------------------------

export interface PhysicsImport {
  readonly json: {
    readonly nodes?: readonly {
      readonly children?: readonly number[];
      readonly extensions?: Readonly<Record<string, unknown>>;
    }[];
    readonly extensions?: Readonly<Record<string, unknown>>;
  };
  /** The local transform of a glTF node. */
  trs(node: number): Trs;
  /** The parent of a glTF node. */
  parent(node: number): number | undefined;
  /** The collision geometry of a glTF mesh, in the space of its node. */
  meshShape(
    mesh: number,
    convexHull: boolean,
    scale: Vec3,
  ): Promise<Shape | undefined>;
  warn(message: string): void;
}

/** The KHR_physics_rigid_bodies extension of a glTF node, if any. */
export const physicsOf = (node: {
  readonly extensions?: Readonly<Record<string, unknown>>;
}): GltfPhysicsNode | undefined =>
  node.extensions?.['KHR_physics_rigid_bodies'] as GltfPhysicsNode | undefined;

/**
 * The bodies of the nodes of a file, by glTF node: the dynamic and
 * kinematic ones with the colliders under them, a static body per collider
 * elsewhere.
 */
export async function importBodies(
  input: PhysicsImport,
): Promise<Map<number, NodeBodyDesc>> {
  const { json, warn } = input;
  const nodes = json.nodes ?? [];
  const root = (json.extensions?.['KHR_physics_rigid_bodies'] ??
    {}) as GltfPhysicsRoot;
  const shapes = ((
    json.extensions?.['KHR_implicit_shapes'] as
      { shapes?: GltfImplicitShape[] } | undefined
  )?.shapes ?? []) as readonly GltfImplicitShape[];

  // The systems of the filters, a bit each (16 at most).
  const systems = new Map<string, number>();
  for (const filter of root.collisionFilters ?? [])
    for (const name of [
      ...(filter.collisionSystems ?? []),
      ...(filter.collideWithSystems ?? []),
      ...(filter.notCollideWithSystems ?? []),
    ])
      if (!systems.has(name)) systems.set(name, systems.size);
  if (systems.size > 16)
    warn('more than 16 collision systems: the others are left out');
  const bits = (names: readonly string[] | undefined) =>
    (names ?? []).reduce((mask, name) => {
      const bit = systems.get(name)!;
      return bit < 16 ? mask | (1 << bit) : mask;
    }, 0);

  const motionOf = (i: number): number | undefined => {
    for (let n: number | undefined = i; n !== undefined; n = input.parent(n))
      if (physicsOf(nodes[n])?.motion) return n;
    return undefined;
  };
  // The transform of a node in the space of an ancestor (undefined: the world).
  const relative = (i: number, ancestor: number | undefined): Trs => {
    const chain: number[] = [];
    for (
      let n: number | undefined = i;
      n !== ancestor && n !== undefined;
      n = input.parent(n)
    )
      chain.push(n);
    return chain
      .reverse()
      .reduce((trs, n) => composeTrs(trs, input.trs(n)), identityTrs);
  };

  const colliderDesc = async (
    i: number,
    collider: GltfCollider,
    sensor: boolean,
  ): Promise<ColliderDesc | undefined> => {
    const owner = motionOf(i);
    const world = relative(i, undefined);
    const geometry = collider.geometry ?? { shape: collider.shape };
    let shape: Shape | undefined;
    if (geometry.shape !== undefined) {
      const implicit = shapes[geometry.shape];
      if (!implicit) {
        warn(`node ${i}: missing shape ${geometry.shape}`);
        return undefined;
      }
      shape = implicitShape(implicit, world.scale, (m) =>
        warn(`node ${i}: ${m}`),
      );
    } else if (geometry.mesh !== undefined) {
      shape = await input.meshShape(
        geometry.mesh,
        geometry.convexHull ?? false,
        world.scale,
      );
    }
    if (!shape) return undefined;
    const material =
      collider.physicsMaterial !== undefined
        ? root.physicsMaterials?.[collider.physicsMaterial]
        : undefined;
    const filter =
      collider.collisionFilter !== undefined
        ? root.collisionFilters?.[collider.collisionFilter]
        : undefined;
    const offset =
      owner !== undefined && owner !== i ? relative(i, owner) : undefined;
    const physicsMaterial: PhysicsMaterial | undefined = material && {
      ...((material.dynamicFriction ?? material.staticFriction) !== undefined
        ? { friction: material.dynamicFriction ?? material.staticFriction }
        : {}),
      ...(material.restitution !== undefined
        ? { restitution: material.restitution }
        : {}),
      ...(material.frictionCombine
        ? { frictionCombine: combines[material.frictionCombine] }
        : {}),
      ...(material.restitutionCombine
        ? { restitutionCombine: combines[material.restitutionCombine] }
        : {}),
    };
    const all = 0xffff;
    const groups = filter?.collisionSystems
      ? bits(filter.collisionSystems)
      : undefined;
    const mask = filter?.collideWithSystems
      ? bits(filter.collideWithSystems)
      : filter?.notCollideWithSystems
        ? all & ~bits(filter.notCollideWithSystems)
        : undefined;
    return {
      shape,
      ...(offset
        ? {
            position: {
              x: offset.translation[0],
              y: offset.translation[1],
              z: offset.translation[2],
            },
            rotation: {
              x: offset.rotation[0],
              y: offset.rotation[1],
              z: offset.rotation[2],
              w: offset.rotation[3],
            },
          }
        : {}),
      ...(physicsMaterial && Object.keys(physicsMaterial).length > 0
        ? { material: physicsMaterial }
        : {}),
      ...(sensor ? { sensor: true } : {}),
      ...(groups !== undefined ? { groups } : {}),
      ...(mask !== undefined ? { mask } : {}),
    };
  };

  const bodies = new Map<number, NodeBodyDesc>();
  const colliders = new Map<number, ColliderDesc[]>();
  for (let i = 0; i < nodes.length; i++) {
    const physics = physicsOf(nodes[i]);
    if (!physics) continue;
    const owner = motionOf(i) ?? i;
    const list = colliders.get(owner) ?? [];
    colliders.set(owner, list);
    for (const [part, sensor] of [
      [physics.collider, false],
      [physics.trigger, true],
    ] as const) {
      if (!part || (!part.geometry && part.shape === undefined)) continue;
      const desc = await colliderDesc(i, part, sensor);
      if (desc) list.push(desc);
    }
  }
  for (const [owner, list] of colliders) {
    const motion = physicsOf(nodes[owner])?.motion;
    if (!motion && list.length === 0) continue;
    const vec = (v: Vec3 | undefined) => v && { x: v[0], y: v[1], z: v[2] };
    const body: NodeBodyDesc = {
      type: !motion ? 'static' : motion.isKinematic ? 'kinematic' : 'dynamic',
      ...(motion?.linearVelocity
        ? { linearVelocity: vec(motion.linearVelocity) }
        : {}),
      ...(motion?.angularVelocity
        ? { angularVelocity: vec(motion.angularVelocity) }
        : {}),
      ...(motion?.gravityFactor !== undefined
        ? { gravityScale: motion.gravityFactor }
        : {}),
      colliders: list,
    };
    bodies.set(owner, body);
  }
  return bodies;
}

// --- Export ------------------------------------------------------------------------

/** What the export of the bodies writes in the file. */
export interface PhysicsExport {
  /** A shape of KHR_implicit_shapes, by index (shared when equal). */
  shape(shape: GltfImplicitShape): number;
  /** A glTF mesh of triangles (or points without indices), for a mesh collider. */
  mesh(vertices: Float32Array, indices: Uint32Array | undefined): number;
  material(material: GltfPhysicsMaterial): number;
  filter(filter: GltfCollisionFilter): number;
  warn(message: string): void;
}

export interface ExportedBody {
  /** The extension of the node of the body. */
  readonly node: GltfPhysicsNode;
  /** The colliders at an offset, on nodes of their own under it. */
  readonly helpers: readonly {
    readonly translation?: Vec3;
    readonly rotation?: Quat;
    readonly physics: GltfPhysicsNode;
  }[];
}

const systemsOf = (mask: number) =>
  Array.from({ length: 16 }, (_, b) => b)
    .filter((b) => mask & (1 << b))
    .map((b) => `group${b}`);

/** A body of the engine in KHR_physics_rigid_bodies. */
export function exportBody(
  data: PhysicsBodyData,
  out: PhysicsExport,
): ExportedBody {
  const body: NodeBodyDesc | undefined = 'body' in data ? data.body : undefined;
  const character: Omit<CharacterDesc, 'position'> | undefined =
    'character' in data ? data.character : undefined;
  const colliders: readonly ColliderDesc[] =
    body?.colliders ??
    (character
      ? [
          {
            shape: character.shape,
            groups: character.groups,
            mask: character.mask,
          },
        ]
      : []);
  const vec = (
    v: { x?: number; y?: number; z?: number } | undefined,
  ): Vec3 | undefined => v && [v.x ?? 0, v.y ?? 0, v.z ?? 0];
  const type = character ? 'kinematic' : body!.type;
  const motion: GltfPhysicsNode['motion'] | undefined =
    type === 'static'
      ? undefined
      : {
          ...(type === 'kinematic' ? { isKinematic: true } : {}),
          ...(body?.linearVelocity
            ? { linearVelocity: vec(body.linearVelocity) }
            : {}),
          ...(body?.angularVelocity
            ? { angularVelocity: vec(body.angularVelocity) }
            : {}),
          ...(body?.gravityScale !== undefined
            ? { gravityFactor: body.gravityScale }
            : {}),
        };

  const collider = (desc: ColliderDesc): GltfCollider | undefined => {
    let geometry: GltfGeometry;
    const implicit = gltfImplicitShape(desc.shape);
    if (implicit) {
      geometry = { shape: out.shape(implicit) };
    } else if (desc.shape.type === 'convex') {
      geometry = {
        mesh: out.mesh(desc.shape.points, desc.shape.indices),
        convexHull: true,
      };
    } else if (desc.shape.type === 'mesh') {
      geometry = { mesh: out.mesh(desc.shape.vertices, desc.shape.indices) };
    } else if (desc.shape.type === 'heightfield') {
      out.warn('a heightfield is written as a mesh of triangles');
      const { vertices, indices } = heightfieldMesh(desc.shape);
      geometry = { mesh: out.mesh(vertices, indices) };
    } else {
      return undefined;
    }
    const m = desc.material;
    const material =
      m &&
      out.material({
        ...(m.friction !== undefined
          ? { staticFriction: m.friction, dynamicFriction: m.friction }
          : {}),
        ...(m.restitution !== undefined ? { restitution: m.restitution } : {}),
        ...(m.frictionCombine
          ? { frictionCombine: gltfCombines[m.frictionCombine] }
          : {}),
        ...(m.restitutionCombine
          ? { restitutionCombine: gltfCombines[m.restitutionCombine] }
          : {}),
      });
    const filtered =
      (desc.groups !== undefined && desc.groups !== 1) ||
      (desc.mask !== undefined && (desc.mask & 0xffff) !== 0xffff);
    const filter = filtered
      ? out.filter({
          collisionSystems: systemsOf(desc.groups ?? 1),
          ...((desc.mask ?? 0xffff) !== 0xffff
            ? { collideWithSystems: systemsOf(desc.mask!) }
            : {}),
        })
      : undefined;
    return {
      geometry,
      ...(material !== undefined ? { physicsMaterial: material } : {}),
      ...(filter !== undefined ? { collisionFilter: filter } : {}),
    };
  };
  const part = (desc: ColliderDesc): GltfPhysicsNode => {
    const c = collider(desc);
    if (!c) return {};
    return desc.sensor ? { trigger: c } : { collider: c };
  };

  const atOrigin = (desc: ColliderDesc) => !desc.position && !desc.rotation;
  if (colliders.length === 1 && atOrigin(colliders[0])) {
    return {
      node: { ...(motion ? { motion } : {}), ...part(colliders[0]) },
      helpers: [],
    };
  }
  return {
    node: motion ? { motion } : {},
    helpers: colliders.map((desc) => ({
      ...(desc.position ? { translation: vec(desc.position) } : {}),
      ...(desc.rotation
        ? {
            rotation: [
              desc.rotation.x,
              desc.rotation.y,
              desc.rotation.z,
              desc.rotation.w,
            ] as const,
          }
        : {}),
      physics: part(desc),
    })),
  };
}
