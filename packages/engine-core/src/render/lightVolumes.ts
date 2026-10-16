import { Aabb, Frustum } from '@fdw/engine-geometry';
import { BaseLight, PointLight, SpotLight } from '../light';
import { lightRange } from './lightRange';
import { lookAxes } from './shadows';

const planes = new Float64Array(24);

/**
 * The pyramid around the cone of a spot light, from the light to its
 * range, written into `out`: its four sides make the angle of the cone with
 * its axis, so the pyramid contains the cone.
 */
export function spotVolume(
  light: SpotLight,
  range: number,
  out: Frustum,
): Frustum {
  const { x: px, y: py, z: pz } = light.position;
  const axes = lookAxes(light.direction);
  // The axis of the cone: -z of the axes.
  const d = axes.z.map((v) => -v);
  const angle = (light.outerCutoff * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const p = [px, py, pz];
  const dot = (a: readonly number[], b: readonly number[]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const write = (plane: number, n: readonly number[], offset: number) => {
    planes.set([n[0], n[1], n[2], offset], plane * 4);
  };
  // A side through the light, its normal turned towards the axis.
  const side = (plane: number, sign: number, axis: readonly number[]) => {
    const n = [0, 1, 2].map((i) => sign * cos * axis[i] + sin * d[i]);
    write(plane, n, -dot(n, p));
  };
  side(0, 1, axes.x);
  side(1, -1, axes.x);
  side(2, 1, axes.y);
  side(3, -1, axes.y);
  // In front of the light, up to the range.
  write(4, d, -dot(d, p));
  write(
    5,
    d.map((v) => -v),
    dot(d, p) + range,
  );
  return out.setPlanes(planes);
}

const spotFrustum = new Frustum();

/**
 * Whether a light can light something in a box: its range for a point
 * light, the pyramid of its cone for a spot. Conservative: a box near the
 * edges can be reported as lit. Always true for the other lights.
 */
export function lightReaches(light: BaseLight, box: Aabb): boolean {
  const range = lightRange(light);
  if (range === Infinity) {
    return true;
  }
  if (light instanceof SpotLight) {
    return (
      spotVolume(light, range, spotFrustum).classifyAabb(box) !== 'outside'
    );
  }
  if (light instanceof PointLight) {
    const { x, y, z } = light.position;
    // The squared distance from the light to the box.
    let distance = 0;
    const center = [x, y, z];
    for (let axis = 0; axis < 3; axis++) {
      const c = center[axis];
      const outside =
        c < box.min[axis]
          ? box.min[axis] - c
          : c > box.max[axis]
            ? c - box.max[axis]
            : 0;
      distance += outside * outside;
    }
    return distance <= range * range;
  }
  return true;
}
