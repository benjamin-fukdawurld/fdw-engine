/**
 * The water at a point of the still surface (x, z), moved by the waves to
 * (x + dx, h, z + dz): the displacement and its derivatives along x and z,
 * from which the normal and the foam come. The same values on the CPU (the
 * physics) and in the shaders.
 */
export interface WaveSample {
  dx: number;
  /** The height above the level of the sea. */
  h: number;
  dz: number;
  /** ∂h/∂x, ∂h/∂z: the slopes. */
  dhdx: number;
  dhdz: number;
  /** ∂dx/∂x, ∂dz/∂z, ∂dx/∂z (= ∂dz/∂x): how the horizontal motion squeezes the surface. */
  dxdx: number;
  dzdz: number;
  dxdz: number;
}

/** A sample of still water. */
export function waveSample(): WaveSample {
  return { dx: 0, h: 0, dz: 0, dhdx: 0, dhdz: 0, dxdx: 0, dzdz: 0, dxdz: 0 };
}

/** Sets a sample to still water. */
export function clearSample(out: WaveSample): WaveSample {
  out.dx = out.h = out.dz = 0;
  out.dhdx = out.dhdz = out.dxdx = out.dzdz = out.dxdz = 0;
  return out;
}

/**
 * The normal of the moved surface: the cross product of its tangents along
 * z, (∂dx/∂z, ∂h/∂z, 1 + ∂dz/∂z), and along x, (1 + ∂dx/∂x, ∂h/∂x, ∂dz/∂x).
 */
export function sampleNormal(s: WaveSample): {
  x: number;
  y: number;
  z: number;
} {
  const x = s.dhdz * s.dxdz - s.dhdx * (1 + s.dzdz);
  const y = (1 + s.dzdz) * (1 + s.dxdx) - s.dxdz * s.dxdz;
  const z = s.dxdz * s.dhdx - s.dhdz * (1 + s.dxdx);
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

/**
 * The jacobian of the horizontal motion: 1 on still water, below 1 where
 * the waves squeeze the surface (their crests), negative where it folds
 * over itself: where the foam forms.
 */
export function sampleJacobian(s: WaveSample): number {
  return (1 + s.dxdx) * (1 + s.dzdz) - s.dxdz * s.dxdz;
}

/**
 * The height of the water above a point of the world, from a field of
 * waves sampled at the points of the still surface: the point of the
 * still surface that the waves move above (x, z) is found by a few fixed
 * point iterations, x0 = x - dx(x0).
 */
export function heightAbove(
  sample: (x: number, z: number, out: WaveSample) => WaveSample,
  x: number,
  z: number,
  out: WaveSample = waveSample(),
  iterations = 6,
): number {
  let x0 = x;
  let z0 = z;
  for (let i = 0; i < iterations; i++) {
    sample(x0, z0, out);
    x0 = x - out.dx;
    z0 = z - out.dz;
  }
  return sample(x0, z0, out).h;
}
