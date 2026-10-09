import { CameraCache, CameraMath, IVec3 } from '@fdw/engine-backend';
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
}

export const castsShadow = (
  light: BaseLight
): light is DirectionalLight | SpotLight =>
  (light instanceof DirectionalLight || light instanceof SpotLight) &&
  light.castShadow;

const normalize = ({ x, y, z }: Readonly<IVec3>): [number, number, number] => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};
const cross = (
  a: readonly number[],
  b: readonly number[]
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
  private readonly _cameras = new WeakMap<
    BaseLight,
    { camera: Camera; cache: CameraCache }
  >();

  constructor(private readonly _math: CameraMath) {}

  /**
   * The tiles of the lights in a square atlas of `atlasSize` pixels: a grid
   * of equal tiles, filled row by row.
   */
  tiles(
    lights: readonly (DirectionalLight | SpotLight)[],
    bounds: Sphere,
    atlasSize: number
  ): ShadowTile[] {
    const columns = Math.ceil(Math.sqrt(lights.length));
    const size = Math.floor(atlasSize / columns);
    const texel = 1 / atlasSize;
    return lights.map((light, index) => {
      const x = (index % columns) * size;
      const y = Math.floor(index / columns) * size;
      const { matrix, normalOffset } = this.view(light, bounds, size);
      return {
        light,
        viewport: { x, y, width: size, height: size },
        matrix,
        shadow: [
          1,
          light.shadow.bias ?? 0,
          (light.shadow.normalBias ?? 1) * normalOffset,
          texel,
        ],
        rect: [x * texel, y * texel, size * texel, size * texel],
      };
    });
  }

  // World to clip space of a light, and the size of a texel of its shadow
  // map (at unit distance for a spot, whose texels grow with the distance).
  private view(
    light: DirectionalLight | SpotLight,
    scene: Sphere,
    size: number
  ): { matrix: Float32Array; normalOffset: number } {
    let entry = this._cameras.get(light);
    if (!entry) {
      const camera = new Camera();
      entry = { camera, cache: new CameraCache(camera, this._math) };
      this._cameras.set(light, entry);
    }
    const { camera, cache } = entry;
    let normalOffset: number;
    if (light instanceof DirectionalLight) {
      const bounds = light.shadow.bounds
        ? {
            center: [
              light.shadow.bounds.center.x,
              light.shadow.bounds.center.y,
              light.shadow.bounds.center.z,
            ],
            radius: light.shadow.bounds.radius,
          }
        : scene;
      const radius = Math.max(bounds.radius, 1e-3);
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
          near: depth - radius * 1.01,
          far: depth + radius * 1.01,
        }
      );
      normalOffset = texel;
    } else {
      // A perspective camera at the spot, covering its cone; near and far
      // planes around the scene.
      const fov = Math.min(2 * light.outerCutoff + 4, 160);
      const { x, y, z } = light.position;
      const distance = Math.hypot(
        scene.center[0] - x,
        scene.center[1] - y,
        scene.center[2] - z
      );
      const far = Math.max(distance + scene.radius, 1e-2);
      const near = Math.max(far * 0.002, distance - scene.radius);
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
  projection: Camera['projection']
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
