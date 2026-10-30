import type { IVec3 } from '@fdw/engine-backend';
import { lightMembers, LightVec4s } from '@fdw/engine-shader';
import { BaseLight, DirectionalLight, PointLight, SpotLight } from '../light';
import { castsShadow, ShadowTile } from './shadows';

/** The floats of a light in the light pool (LightVec4s vec4). */
export const LightPoolStride = LightVec4s * 4;

const offset = (member: string) => lightMembers[member].offset * 4;
const position = offset('position');
const ambient = offset('ambient');
const diffuse = offset('diffuse');
const specular = offset('specular');
const attenuation = offset('attenuation');
const spotDirection = offset('spotDirection');
const spotCone = offset('spotCone');
const shadow = offset('shadow');
const shadowRect = offset('shadowRect');
const shadowMatrix = offset('shadowMatrix');

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A direction, normalized and scaled (-1: the opposite), and w.
function writeDirection(
  out: Float32Array,
  at: number,
  { x, y, z }: Readonly<IVec3>,
  scale: number,
  w: number,
): void {
  const length = (Math.hypot(x, y, z) || 1) / scale;
  out[at] = x / length;
  out[at + 1] = y / length;
  out[at + 2] = z / length;
  out[at + 3] = w;
}

const writeColor = (out: Float32Array, at: number, value: Readonly<IVec3>) => {
  out[at] = value.x;
  out[at + 1] = value.y;
  out[at + 2] = value.z;
};

/**
 * Writes lights into a light pool, the storage buffer the materials read
 * them from (see lightMembers in engine-shader): LightVec4s vec4 per
 * light, in the order given. Directional, point and spot lights; the
 * others are black. Returns `out`, or a new array when it is too small.
 *
 * `shadows` are the tiles of the shadow atlas of the lights casting
 * shadows (the renderer's). With `rayOffset`, the shadows are traced by
 * rays: the lights casting shadows get (1, 0, rayOffset, softness) (see
 * light.shadowRay).
 */
export function writeLightPool(
  lights: readonly BaseLight[],
  out?: Float32Array<ArrayBuffer>,
  shadows: readonly ShadowTile[] = [],
  rayOffset?: number,
): Float32Array<ArrayBuffer> {
  // At least one light: a buffer is never empty.
  const size = Math.max(lights.length, 1) * LightPoolStride;
  const pool =
    out && out.length >= size ? out : new Float32Array(Math.max(size, 256));
  pool.fill(0, 0, size);
  for (let i = 0; i < lights.length; i++) {
    const light = lights[i];
    const base = i * LightPoolStride;
    pool[base + attenuation] = 1;
    // A cone lighting every direction: the spot factor is always 1.
    pool[base + spotCone] = -1;
    pool[base + spotCone + 1] = -2;
    pool.set(identity, base + shadowMatrix);
    if (light instanceof DirectionalLight) {
      // Towards the light: the opposite of the direction it shines in.
      writeDirection(pool, base + position, light.direction, -1, 0);
    } else if (light instanceof PointLight || light instanceof SpotLight) {
      const { x, y, z } = light.position;
      pool.set([x, y, z, 1], base + position);
      pool[base + attenuation] = light.constantAttenuation;
      pool[base + attenuation + 1] = light.linearAttenuation;
      pool[base + attenuation + 2] = light.quadraticAttenuation;
      if (light instanceof SpotLight) {
        // Cutoffs are half-angles of the cone, in degrees. The inner cosine
        // stays above the outer one: the shader divides by their
        // difference.
        const cosine = (degrees: number) => Math.cos((degrees * Math.PI) / 180);
        const outer = cosine(light.outerCutoff);
        pool[base + spotCone] = Math.max(
          cosine(light.innerCutoff),
          outer + 1e-4,
        );
        pool[base + spotCone + 1] = outer;
        writeDirection(pool, base + spotDirection, light.direction, 1, 0);
      }
    } else {
      continue;
    }
    writeColor(pool, base + ambient, light.ambient);
    writeColor(pool, base + diffuse, light.diffuse);
    writeColor(pool, base + specular, light.specular);
    // The first tile of the light: its own, or its first cascade (whose
    // shadow.x of 2 sends the shaders to the cascades).
    const tile = shadows.find((candidate) => candidate.light === light);
    if (rayOffset !== undefined && castsShadow(light)) {
      pool.set([1, 0, rayOffset, light.shadow.softness ?? 0], base + shadow);
    } else if (tile) {
      pool.set(tile.shadow, base + shadow);
    }
    if (tile) {
      pool.set(tile.rect, base + shadowRect);
      pool.set(tile.matrix, base + shadowMatrix);
    }
  }
  return pool;
}
