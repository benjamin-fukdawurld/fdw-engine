import type { MaterialValue } from '@fdw/engine-core';
import { arrayType, BuiltinTypes } from '@fdw/engine-shader';
import type { GraphBuilder, PortHandle } from '@fdw/engine-shader';
import type { GerstnerWaves } from './gerstner';
import type { OceanSpectrum } from './OceanSpectrum';
import { Ops } from './ops';

/** The derivatives of the waves at a point, in a fragment shader. */
export interface WaveDerivatives {
  /** ∂h/∂x, ∂h/∂z (vec2). */
  readonly slopes: PortHandle;
  /** ∂dx/∂x, ∂dz/∂z, ∂dx/∂z (vec3). */
  readonly squeeze: PortHandle;
  /**
   * The variance of the slopes of the waves too small for the pixel, left
   * out (f32): the material makes the water rougher by as much.
   */
  readonly lostSlopes: PortHandle;
}

/**
 * The waves in a material graph: their displacement in the vertex stage,
 * their derivatives in the fragment stage, at the points of the still
 * surface (world x, z). What the {@link Ocean} builds its material on.
 */
export interface WaveShader {
  /**
   * The displacement (vec3) of the still point `xz`, in the vertex stage.
   * Each wave fades out with the distance to the camera, before the
   * vertices get too far apart for it: at `fade` times its length.
   */
  displacement(
    g: GraphBuilder,
    xz: PortHandle,
    distance: PortHandle,
    fade: { readonly scale: number; readonly limit: number },
  ): PortHandle;
  /**
   * The derivatives at the still point `xz`, in the fragment stage; the
   * waves shorter than a few `footprint`s (the size of the pixel on the
   * water, in meters) fade out.
   */
  derivatives(
    g: GraphBuilder,
    xz: PortHandle,
    footprint: PortHandle,
  ): WaveDerivatives;
  /** The values of the material: set once, and after each update. */
  values(): Readonly<Record<string, MaterialValue>>;
  /**
   * Where there is water at the still point `xz`, in the fragment stage:
   * from 0 (dry) to 1. The pixels under 0.5 are discarded: the material
   * needs the `mask` alpha mode. Water everywhere without it.
   */
  coverage?(g: GraphBuilder, xz: PortHandle): PortHandle;
}

const vec4Array = arrayType(BuiltinTypes.vec4f);

// 1 near, 0 from `end` on, fading from half of it.
const fadeOut = (o: Ops, distance: PortHandle, end: number) =>
  o.sub(1, o.smoothstep(end / 2, end, distance));

/**
 * The shader of an {@link OceanSpectrum}: its two storage buffers read
 * between their four nearest points (bilinear, the tiles repeating), the
 * cascades added.
 */
export function spectrumShader(spectrum: OceanSpectrum): WaveShader {
  const { resolution: n, cascades, slopeVariances } = spectrum.data;
  const declared = new WeakMap<GraphBuilder, Record<string, PortHandle>>();
  const buffer = (g: GraphBuilder, name: string) => {
    let buffers = declared.get(g);
    if (!buffers) {
      buffers = {};
      declared.set(g, buffers);
    }
    buffers[name] ??= g.storage(name, vec4Array);
    return buffers[name];
  };
  // The bilinear reads of cascade c at xz, in each buffer.
  const reader = (o: Ops, xz: PortHandle, c: number) => {
    const uv = o.mul(xz, n / cascades[c]);
    const cell = o.floor(uv);
    const t = o.sub(uv, cell);
    const ij = o.convert(cell, BuiltinTypes.vec2i);
    const corner = (di: number, dj: number) => {
      const i = o.and(o.add(ij.swizzle('x'), di), n - 1);
      const j = o.and(o.add(ij.swizzle('y'), dj), n - 1);
      return o.add(o.mul(o.add(j, c * n), n), i);
    };
    const corners = [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)];
    return (array: PortHandle) => {
      const [a, b, c2, d] = corners.map((index) => o.index(array, index));
      return o.mix(
        o.mix(a, b, t.swizzle('x')),
        o.mix(c2, d, t.swizzle('x')),
        t.swizzle('y'),
      );
    };
  };
  return {
    displacement(g, xz, distance, fade) {
      const o = new Ops(g);
      const array = buffer(g, 'oceanDisplacement');
      return o.sum(
        cascades.map((side, c) =>
          o.mul(
            reader(o, xz, c)(array).swizzle('xyz'),
            fadeOut(o, distance, Math.min(side * fade.scale, fade.limit)),
          ),
        ),
      );
    },
    derivatives(g, xz, footprint) {
      const o = new Ops(g);
      const displacement = buffer(g, 'oceanDisplacement');
      const derivatives = buffer(g, 'oceanDerivatives');
      const slopes: PortHandle[] = [];
      const squeeze: PortHandle[] = [];
      const lost: PortHandle[] = [];
      cascades.forEach((side, c) => {
        // The texels of the cascade in the pixel: from 1 on, it aliases.
        const texels = o.div(footprint, side / n);
        const kept = o.sub(1, o.smoothstep(0.75, 2.5, texels));
        const read = reader(o, xz, c);
        const d = read(derivatives);
        const dxdz = read(displacement).swizzle('w');
        slopes.push(o.mul(d.swizzle('xy'), kept));
        squeeze.push(o.mul(o.vec3(d.swizzle('z'), d.swizzle('w'), dxdz), kept));
        lost.push(o.mul(o.sub(1, kept), slopeVariances[c]));
      });
      return {
        slopes: o.sum(slopes),
        squeeze: o.sum(squeeze),
        lostSlopes: o.sum(lost),
      };
    },
    values: () => ({
      oceanDisplacement: spectrum.displacement,
      oceanDerivatives: spectrum.derivatives,
    }),
  };
}

/**
 * The shader of {@link GerstnerWaves}: the waves summed in the graph, their
 * directions and lengths as constants, their phases at the time of the
 * waves in uniforms (`wavePhases0`… four per vec4), updated each frame.
 */
export function gerstnerShader(waves: GerstnerWaves): WaveShader {
  const constants = waves.constants;
  const declared = new WeakMap<GraphBuilder, PortHandle[]>();
  const phases = (g: GraphBuilder) => {
    let uniforms = declared.get(g);
    if (!uniforms) {
      uniforms = Array.from(
        { length: Math.ceil(constants.length / 4) },
        (_, i) => g.uniform(`wavePhases${i}`, BuiltinTypes.vec4f),
      );
      declared.set(g, uniforms);
    }
    return constants.map((_, i) =>
      (uniforms as PortHandle[])[i >> 2].swizzle('xyzw'[i & 3]),
    );
  };
  // The angle of each wave at xz.
  const angles = (o: Ops, xz: PortHandle) => {
    const phase = phases(o.g);
    return constants.map((wave, i) =>
      o.add(o.dot(xz, [wave.dx * wave.k, wave.dz * wave.k]), phase[i]),
    );
  };
  return {
    displacement(g, xz, distance, fade) {
      const o = new Ops(g);
      const theta = angles(o, xz);
      return o.sum(
        constants.map((wave, i) => {
          const cos = o.cos(theta[i]);
          const motion = o.vec3(
            o.mul(cos, wave.horizontal * wave.dx),
            o.mul(o.sin(theta[i]), wave.amplitude),
            o.mul(cos, wave.horizontal * wave.dz),
          );
          const length = (2 * Math.PI) / wave.k;
          return o.mul(
            motion,
            fadeOut(o, distance, Math.min(length * fade.scale, fade.limit)),
          );
        }),
      );
    },
    derivatives(g, xz, footprint) {
      const o = new Ops(g);
      const theta = angles(o, xz);
      const slopes: PortHandle[] = [];
      const squeeze: PortHandle[] = [];
      const lost: PortHandle[] = [];
      constants.forEach((wave, i) => {
        const length = (2 * Math.PI) / wave.k;
        // Four pixels a wave length at least.
        const kept = o.sub(
          1,
          o.smoothstep(0.25, 0.5, o.div(footprint, length)),
        );
        const cos = o.mul(o.cos(theta[i]), kept);
        const sin = o.mul(o.sin(theta[i]), kept);
        const ak = wave.amplitude * wave.k;
        const qk = wave.horizontal * wave.k;
        slopes.push(o.mul(cos, [ak * wave.dx, ak * wave.dz]));
        squeeze.push(
          o.mul(sin, [
            -qk * wave.dx * wave.dx,
            -qk * wave.dz * wave.dz,
            -qk * wave.dx * wave.dz,
          ]),
        );
        lost.push(o.mul(o.sub(1, kept), (ak * ak) / 2));
      });
      return {
        slopes: o.sum(slopes),
        squeeze: o.sum(squeeze),
        lostSlopes: o.sum(lost),
      };
    },
    values: () => {
      const values: Record<string, MaterialValue> = {};
      const current = waves.phases();
      for (let i = 0; i < current.length; i += 4) {
        values[`wavePhases${i >> 2}`] = [0, 1, 2, 3].map(
          (k) => current[i + k] ?? 0,
        );
      }
      return values;
    },
  };
}
