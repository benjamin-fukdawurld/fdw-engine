import {
  arrayType,
  BuiltinTypes,
  GraphBuilder,
  MaterialGraphData,
  Ops,
  PortHandle,
  RayAlphaMaskSize,
  RayAlphaMaskVec4s,
  RaySurfaceVec4s,
  RayVertexVec4s,
} from '@fdw/engine-shader';

// The alpha masks of the traced scene (see RayAlphaMaskSize): the surface
// of a masked material evaluated by its hit program over the square of its
// uv, at the centers of the texels of its mask, then cut at its cutoff and
// packed in bits by alphaMaskKernel. The points evaluated are those of a
// square of the scene's geometry, the uv of its corners from (0, 0) to
// (1, 1), hit by made up rays: what the alpha of a material reads of its
// uv (its textures) is in the mask; what it reads of the position or of
// the object is that of the square.

/** The rays of a bake: a texel each. */
export const AlphaMaskTexels = RayAlphaMaskSize * RayAlphaMaskSize;

/**
 * The geometry of the square of the bakes: its 2 triangles (a vec4 each,
 * the offsets of their vertices, from `first`, where the triangles are
 * followed by the vertices), then its 4 vertices (RayVertexVec4s vec4
 * each: the position and u, the normal and v, the tangent).
 */
export function alphaMaskSquare(first: number): Float32Array<ArrayBuffer> {
  const data = new Float32Array((2 + 4 * RayVertexVec4s) * 4);
  const words = new Uint32Array(data.buffer);
  const vertex = (k: number) => first + 2 + k * RayVertexVec4s;
  words.set([vertex(0), vertex(1), vertex(2), 0], 0);
  words.set([vertex(0), vertex(2), vertex(3), 0], 4);
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].forEach(([x, y], k) => {
    data.set(
      [x, y, 0, x, 0, 0, 1, y, 1, 0, 0, 1],
      (2 + k * RayVertexVec4s) * 4,
    );
  });
  return data;
}

/**
 * The hits of a bake, a vec4<u32> per texel of the mask (rows of
 * increasing v): the instance of the square, its triangle under the center
 * of the texel, the barycentric coordinates of the center.
 */
export function alphaMaskHits(instance: number): Uint32Array<ArrayBuffer> {
  const hits = new Uint32Array(AlphaMaskTexels * 4);
  const floats = new Float32Array(hits.buffer);
  for (let texel = 0; texel < AlphaMaskTexels; texel++) {
    const s = ((texel % RayAlphaMaskSize) + 0.5) / RayAlphaMaskSize;
    const t = (Math.floor(texel / RayAlphaMaskSize) + 0.5) / RayAlphaMaskSize;
    // The first triangle, (0, 0) (1, 0) (1, 1): the point is (u + v, v);
    // the second, (0, 0) (1, 1) (0, 1): (u, u + v).
    const lower = t <= s;
    hits[texel * 4] = instance;
    hits[texel * 4 + 1] = lower ? 0 : 1;
    floats[texel * 4 + 2] = lower ? s - t : s;
    floats[texel * 4 + 3] = lower ? t : t - s;
  }
  return hits;
}

/**
 * The kernel packing the surfaces of a bake (raySurfaces) into a mask: a
 * vec4 of 128 bits per thread, written to `masks` at `maskOffset`. A bit is
 * set where the alpha reaches the cutoff of the surface.
 */
export function alphaMaskKernel(): MaterialGraphData {
  const g = new GraphBuilder('alpha mask');
  const s = new Ops(g);
  const index = g.builtin('global-invocation-id').swizzle('x');
  const offset = g.uniform('maskOffset', BuiltinTypes.u32);
  const surfaces = g.storage('raySurfaces', arrayType(BuiltinTypes.vec4f));
  const masks = g.storage('masks', arrayType(BuiltinTypes.vec4f), {
    access: 'read-write',
  });
  const words = [0, 1, 2, 3].map((k) =>
    g.fold(
      s.u32(0),
      32,
      (word, bit) => {
        const texel = s.add(
          s.add(s.mul(index, s.u32(128)), s.u32(k * 32)),
          bit,
        );
        const at = s.mul(texel, s.u32(RaySurfaceVec4s));
        const alpha = s.index(surfaces, at).swizzle('w');
        const cutoff = s.index(surfaces, s.add(at, s.u32(3))).swizzle('z');
        return s.bitOr(
          word,
          s.select(
            s.u32(0),
            s.shl(s.u32(1), bit),
            s.greaterEqual(alpha, cutoff),
          ),
        );
      },
      { label: `word ${k}` },
    ),
  );
  g.write(masks, {
    index: s.add(offset, index),
    value: s.vec4(
      ...(words.map((word) => s.bitcast(word, BuiltinTypes.f32)) as [
        PortHandle,
        PortHandle,
        PortHandle,
        PortHandle,
      ]),
    ),
  });
  g.compute({
    workgroupSize: [64, 1, 1],
    active: s.less(index, s.u32(RayAlphaMaskVec4s)),
  });
  return g.build();
}
