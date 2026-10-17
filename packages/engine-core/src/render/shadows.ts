import { CameraCache, CameraMath, IVec3 } from '@fdw/engine-backend';
import type { Aabb } from '@fdw/engine-geometry';
import { Camera } from '../Camera';
import { BaseLight, DirectionalLight, SpotLight } from '../light';
import type { Sphere } from './bounds';

// The shadow maps of the lights: the cameras the lights see the scene with,
// and their tiles in the shadow atlas.

/** A light with shadows, and where its shadow map is in the atlas. */
export interface ShadowTile {
  readonly light: DirectionalLight | SpotLight;
  // In pixels of the atlas, from its top left corner.
  readonly viewport: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  // World to clip space of the light.
  readonly matrix: Float32Array;
  // The shadow values of the light in the frame uniforms (see lightMembers
  // in engine-shader): shadow (enabled, bias, normal offset, texel size)
  // and shadowRect (uv offset and size of the tile).
  readonly shadow: readonly number[];
  readonly rect: readonly number[];
  // The tiles of the cascaded light: which cascade, and the view depth
  // where it ends.
  readonly cascade?: number;
  readonly split?: number;
}

/**
 * The view depths where the shadow cascades of a camera end: `count`
 * slices from its near plane to `distance`, between even (`lambda` 0) and
 * geometric (1) steps (Zhang et al. 2006, "Parallel-split shadow maps").
 */
export function cascadeSplits(
  near: number,
  distance: number,
  count: number,
  lambda: number,
): number[] {
  const splits: number[] = [];
  for (let i = 1; i <= count; i++) {
    const even = near + ((distance - near) * i) / count;
    const geometric = near * (distance / near) ** (i / count);
    splits.push(lambda * geometric + (1 - lambda) * even);
  }
  return splits;
}

/**
 * The smallest sphere around the slice of a perspective view between the
 * view depths `from` and `to`, its center on the axis of the view: the
 * distance of its center from the camera, and its radius. Neither depends
 * on where the camera looks: the cascades keep their size as it turns.
 */
export function sliceSphere(
  fov: number,
  aspect: number,
  from: number,
  to: number,
): { depth: number; radius: number } {
  // The corners of the slice at depth z are z × k from the axis.
  const tan = Math.tan((fov * Math.PI) / 360);
  const k2 = tan * tan * (1 + aspect * aspect);
  // The center as far from the near corners as from the far ones, at most
  // at the far end.
  const depth = Math.min(((from + to) * (1 + k2)) / 2, to);
  const radius = Math.max(
    Math.sqrt((depth - from) ** 2 + from * from * k2),
    Math.sqrt((to - depth) ** 2 + to * to * k2),
  );
  return { depth, radius };
}

export const castsShadow = (
  light: BaseLight,
): light is DirectionalLight | SpotLight =>
  (light instanceof DirectionalLight || light instanceof SpotLight) &&
  light.castShadow;

const normalize = ({ x, y, z }: Readonly<IVec3>): [number, number, number] => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};
const cross = (
  a: readonly number[],
  b: readonly number[],
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: readonly number[]): [number, number, number] => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * The axes of a camera looking in a direction (its -z axis), the up
 * direction (+y) as close as possible to the world +y.
 */
export function lookAxes(direction: Readonly<IVec3>): {
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
} {
  const z = normalize(direction).map((v) => -v) as [number, number, number];
  const up = Math.abs(z[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const x = unit(cross(up, z));
  return { x, y: cross(z, x), z };
}

/** The rotation (a quaternion) of a camera looking in a direction. */
export function lookRotation(direction: Readonly<IVec3>): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  const { x: X, y: Y, z: Z } = lookAxes(direction);
  // Rotation matrix with the axes as columns, to a quaternion.
  const [m00, m01, m02] = [X[0], Y[0], Z[0]];
  const [m10, m11, m12] = [X[1], Y[1], Z[1]];
  const [m20, m21, m22] = [X[2], Y[2], Z[2]];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return {
      w: 0.25 / s,
      x: (m21 - m12) * s,
      y: (m02 - m20) * s,
      z: (m10 - m01) * s,
    };
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return {
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    };
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return {
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    };
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return {
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
  };
}

/**
 * The cameras of the lights with shadows, kept from frame to frame: their
 * matrices are only recomputed when the light or the scene bounds move.
 */
export class ShadowCameras {
  // A camera per light, and per cascade of the cascaded light.
  private readonly _cameras = new WeakMap<
    BaseLight,
    { camera: Camera; cache: CameraCache }[]
  >();

  constructor(private readonly _math: CameraMath) {}

  /**
   * The tiles of the lights in a square atlas of `atlasSize` pixels: a grid
   * of equal tiles, filled row by row, one per light and one per cascade
   * of the cascaded light. `receivers` is what the camera sees: the shadow
   * maps cover it. `scene`, the bounds of everything, says how far towards
   * the light casters can be. `camera` is cut into the cascades of the
   * first directional light with `shadow.cascades` (a perspective camera).
   */
  tiles(
    lights: readonly (DirectionalLight | SpotLight)[],
    receivers: Sphere,
    scene: Aabb | undefined,
    atlasSize: number,
    camera?: Camera,
  ): ShadowTile[] {
    const projection = camera?.projection;
    const cascaded =
      projection?.type === 'perspective'
        ? lights.find(
            (light): light is DirectionalLight =>
              light instanceof DirectionalLight && !!light.shadow.cascades,
          )
        : undefined;
    // The cascades of the cascaded light: their bounds and splits.
    const cascades: { bounds: Sphere; split: number }[] = [];
    const options = cascaded?.shadow.cascades;
    if (options && camera && projection?.type === 'perspective') {
      const count = Math.min(Math.max(Math.round(options.count ?? 4), 1), 4);
      const distance = Math.min(
        options.distance ?? projection.far,
        projection.far,
      );
      const splits = cascadeSplits(
        projection.near,
        distance,
        count,
        options.lambda ?? 0.75,
      );
      const forward = rotate(camera.rotation, [0, 0, -1]);
      const { x, y, z } = camera.position;
      let from = projection.near;
      for (const split of splits) {
        const { depth, radius } = sliceSphere(
          projection.fov,
          projection.aspect,
          from,
          split,
        );
        cascades.push({
          bounds: {
            center: [
              x + forward[0] * depth,
              y + forward[1] * depth,
              z + forward[2] * depth,
            ],
            radius,
          },
          split,
        });
        from = split;
      }
    }
    const slots = lights.length + Math.max(cascades.length - 1, 0);
    const columns = Math.ceil(Math.sqrt(slots));
    const size = Math.floor(atlasSize / columns);
    const texel = 1 / atlasSize;
    const tiles: ShadowTile[] = [];
    const tile = (
      light: DirectionalLight | SpotLight,
      bounds: Sphere | undefined,
      cascade?: { index: number; split: number },
    ) => {
      const index = tiles.length;
      const x = (index % columns) * size;
      const y = Math.floor(index / columns) * size;
      const { matrix, normalOffset } = this.view(
        light,
        bounds ?? receivers,
        bounds !== undefined,
        scene,
        size,
        cascade?.index ?? 0,
      );
      tiles.push({
        light,
        viewport: { x, y, width: size, height: size },
        matrix,
        shadow: [
          cascade ? 2 : 1,
          light.shadow.bias ?? 0,
          (light.shadow.normalBias ?? 1) * normalOffset,
          texel,
        ],
        rect: [x * texel, y * texel, size * texel, size * texel],
        ...(cascade ? { cascade: cascade.index, split: cascade.split } : {}),
      });
    };
    for (const light of lights) {
      if (light === cascaded) {
        cascades.forEach(({ bounds, split }, index) =>
          tile(light, bounds, { index, split }),
        );
      } else {
        tile(light, undefined);
      }
    }
    return tiles;
  }

  // World to clip space of a light, and the size of a texel of its shadow
  // map (at unit distance for a spot, whose texels grow with the distance).
  // `cascade` says which of the cameras of the light (its cascades);
  // `given` that `receivers` are the bounds of a cascade, not to be
  // replaced by those of the light.
  private view(
    light: DirectionalLight | SpotLight,
    receivers: Sphere,
    given: boolean,
    scene: Aabb | undefined,
    size: number,
    cascade: number,
  ): { matrix: Float32Array; normalOffset: number } {
    let entries = this._cameras.get(light);
    if (!entries) {
      entries = [];
      this._cameras.set(light, entries);
    }
    let entry = entries[cascade];
    if (!entry) {
      const camera = new Camera();
      entry = { camera, cache: new CameraCache(camera, this._math) };
      entries[cascade] = entry;
    }
    const { camera, cache } = entry;
    let normalOffset: number;
    if (light instanceof DirectionalLight) {
      const bounds =
        light.shadow.bounds && !given
          ? {
              center: [
                light.shadow.bounds.center.x,
                light.shadow.bounds.center.y,
                light.shadow.bounds.center.z,
              ],
              radius: light.shadow.bounds.radius,
            }
          : receivers;
      // The radius by steps of about 19 % (2^¼): the texels keep their size
      // while the visible region changes a little, and the shadows do not
      // shimmer as the camera moves.
      const radius = Math.max(
        2 ** (Math.ceil(Math.log2(Math.max(bounds.radius, 1e-3)) * 4) / 4),
        1e-3,
      );
      // A camera at the origin, looking along the light: the bounds, in its
      // space, give the box of the orthographic projection. Its center
      // moves by whole texels, so that the shadows do not shimmer when the
      // scene moves.
      const axes = lookAxes(light.direction);
      const texel = (2 * radius) / size;
      const snap = (value: number) => Math.round(value / texel) * texel;
      const cx = snap(dot(bounds.center, axes.x));
      const cy = snap(dot(bounds.center, axes.y));
      // In front of the camera: along -z.
      const depth = -dot(bounds.center, axes.z);
      // Towards the light, as far as the scene goes: the casters of the
      // shadows falling on the receivers. Without the scene bounds, a few
      // times the radius.
      const towardsLight = scene
        ? Math.max(radius, depth + supportAlong(scene, axes.z))
        : 4 * radius;
      setIfChanged(
        camera,
        { x: 0, y: 0, z: 0 },
        lookRotation(light.direction),
        {
          type: 'orthographic',
          left: cx - radius,
          right: cx + radius,
          bottom: cy - radius,
          top: cy + radius,
          near: depth - towardsLight * 1.01,
          far: depth + radius * 1.01,
        },
      );
      normalOffset = texel;
    } else {
      // A perspective camera at the spot, covering its cone, as far as the
      // receivers; the casters can be anywhere between them and the spot.
      const fov = Math.min(2 * light.outerCutoff + 4, 160);
      const { x, y, z } = light.position;
      const distance = Math.hypot(
        receivers.center[0] - x,
        receivers.center[1] - y,
        receivers.center[2] - z,
      );
      const far = Math.max(distance + receivers.radius, 1e-2);
      const near = far * 0.002;
      setIfChanged(camera, { x, y, z }, lookRotation(light.direction), {
        type: 'perspective',
        fov,
        aspect: 1,
        near,
        far,
      });
      normalOffset = (2 * Math.tan((fov * Math.PI) / 360)) / size;
    }
    return { matrix: cache.viewProjectionMatrix.value, normalOffset };
  }
}

// Updates a camera only where its values change, so that its cached
// matrices stay valid when the light does not move.
function setIfChanged(
  camera: Camera,
  position: IVec3,
  rotation: { x: number; y: number; z: number; w: number },
  projection: Camera['projection'],
): void {
  // The camera stores 32-bit floats.
  const f = Math.fround;
  const p = camera.position;
  if (p.x !== f(position.x) || p.y !== f(position.y) || p.z !== f(position.z)) {
    camera.position = position;
  }
  const r = camera.rotation;
  if (
    r.x !== f(rotation.x) ||
    r.y !== f(rotation.y) ||
    r.z !== f(rotation.z) ||
    r.w !== f(rotation.w)
  ) {
    camera.rotation = rotation;
  }
  if (JSON.stringify(camera.projection) !== JSON.stringify(projection)) {
    camera.projection = projection;
  }
}

// A vector turned by a quaternion.
function rotate(
  q: { x: number; y: number; z: number; w: number },
  v: readonly number[],
): [number, number, number] {
  // v + 2w (q × v) + 2 q × (q × v)
  const u = [q.x, q.y, q.z];
  const t = cross(u, v).map((c) => 2 * c);
  const c = cross(u, t);
  return [
    v[0] + q.w * t[0] + c[0],
    v[1] + q.w * t[1] + c[1],
    v[2] + q.w * t[2] + c[2],
  ];
}

// The largest value of dot(p, axis) over the points p of a box.
function supportAlong({ min, max }: Aabb, axis: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    sum += axis[i] * (axis[i] >= 0 ? max[i] : min[i]);
  }
  return sum;
}
