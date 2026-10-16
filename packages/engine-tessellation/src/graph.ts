import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type { ConstantValue, PortHandle, ShaderType } from '@fdw/engine-shader';
import { PatchesPerRow, PatchTextureWidth, TexelsPerPatch } from './patches';

type Value = PortHandle | ConstantValue;

/**
 * The names of the values a {@link PatchSurface} sets on its material,
 * read by {@link patchVertex}.
 */
export const PatchValues = {
  // The corners of the patches (rgba32float).
  patches: 'patchData',
  // The patches drawn, sorted by level: a texel each (rgba32float).
  draws: 'patchDraws',
  // The first vertex of each level, from 0 to 6, then the vertex count.
  vertexStarts: ['patchVertexStarts0', 'patchVertexStarts1'],
  // The first draw of each level.
  drawStarts: ['patchDrawStarts0', 'patchDrawStarts1'],
} as const;

/** A height map moving the vertices along their normal. */
export interface PatchDisplacement {
  readonly texture: PortHandle;
  readonly sampler: PortHandle;
  /** The height of a texel of 1, in object units (0.1 by default). */
  readonly scale?: Value;
  /** Added to the height before scaling: -0.5 centers the relief. */
  readonly bias?: Value;
  /**
   * The distance between the heights the normal is computed from, in uv:
   * 1 / the size of the height map (1 / 256 by default).
   */
  readonly texel?: Value;
}

/** What {@link patchVertex} computes, in the vertex stage. */
export interface PatchVertex {
  /** The position, displaced, in object space. */
  readonly position: PortHandle;
  /** The normal of the displaced surface, in object space. */
  readonly normal: PortHandle;
  readonly uv: PortHandle;
  /** The height read from the height map (0 without displacement). */
  readonly height: PortHandle;
  /** The level of the patch, from 0 to 6 (an f32): to show the levels. */
  readonly level: PortHandle;
}

/**
 * The vertex of a patch, generated from its index: the material of a
 * {@link PatchSurface}. Finds the patch and the point of its template
 * drawn, moves the points of the edges onto the grid of their level (no
 * crack), interpolates the corners, displaces the point by the height map
 * and computes the normal of the displaced surface. Sets the `position`,
 * `normal` and `uv` attributes of the graph (`g.vertexAttribute`): the
 * surface, the macros, `g.attribute('uv')` read them.
 *
 * @example
 * ```ts
 * const g = new GraphBuilder('terrain');
 * const vertex = patchVertex(g, {
 *   displacement: { texture: g.texture('height'), sampler: g.sampler('heightSampler'), scale: 40 },
 * });
 * g.surface({ shadingModel: 'pbr', baseColor: color(vertex.height) });
 * ```
 */
export function patchVertex(
  g: GraphBuilder,
  options: { displacement?: PatchDisplacement } = {},
): PatchVertex {
  const call = (fn: Parameters<GraphBuilder['call']>[0], inputs: object) =>
    g.call(fn, inputs as Record<string, Value>);
  const convert = (value: Value, to: ShaderType) =>
    g.call(std.convert, { value }, { params: { to } });
  const u32 = (value: Value) => convert(value, BuiltinTypes.u32);
  const f32 = (value: Value) => convert(value, BuiltinTypes.f32);
  const uint = (value: number) => g.constant(BuiltinTypes.u32, value);
  const add = (a: Value, b: Value) => call(std.add, { a, b });
  const sub = (a: Value, b: Value) => call(std.sub, { a, b });
  const mul = (a: Value, b: Value) => call(std.mul, { a, b });
  const div = (a: Value, b: Value) => call(std.div, { a, b });
  const max = (a: Value, b: Value) => call(std.max, { a, b });
  const select = (ifFalse: Value, ifTrue: Value, condition: Value) =>
    call(std.select, { ifFalse, ifTrue, condition });
  const equal = (a: Value, b: Value) => call(std.equal, { a, b });
  // Rounded down to a multiple of a step (integers).
  const snap = (value: Value, step: Value) => mul(div(value, step), step);

  // --- The level of the vertex: the draws are sorted by level, each level
  // starting at a vertex; levels without patches start where the next does.
  const index = f32(g.builtin('vertex-index'));
  const splat = call(std.vec4, { x: index, y: index, z: index, w: index });
  let vertexStart: PortHandle | undefined;
  let drawStart: PortHandle | undefined;
  let size: PortHandle | undefined;
  // The number of levels reached, level 0 included.
  let reachedLevels: PortHandle | undefined;
  for (const half of [0, 1] as const) {
    const starts = g.uniform(
      PatchValues.vertexStarts[half],
      BuiltinTypes.vec4f,
    );
    // 1 for the levels starting at or before the vertex.
    const reached = call(std.step, { edge: starts, x: splat });
    const sizes = half === 0 ? [1, 2, 4, 8] : [16, 32, 64, 0];
    const vertex = mul(starts, reached);
    const draw = mul(
      g.uniform(PatchValues.drawStarts[half], BuiltinTypes.vec4f),
      reached,
    );
    const quads = mul(g.constant(BuiltinTypes.vec4f, sizes), reached);
    const count = call(std.dot, { a: reached, b: [1, 1, 1, 1] });
    reachedLevels = reachedLevels ? add(reachedLevels, count) : count;
    vertexStart = vertexStart ? max(vertexStart, vertex) : vertex;
    drawStart = drawStart ? max(drawStart, draw) : draw;
    size = size ? max(size, quads) : quads;
  }
  const largest = (v: PortHandle) =>
    max(
      max(v.swizzle('x'), v.swizzle('y')),
      max(v.swizzle('z'), v.swizzle('w')),
    );
  // The quads along an edge of the template: 2^level.
  const n = u32(largest(size as PortHandle));

  // --- The draw, the quad and the corner of the vertex.
  const local = u32(sub(index, largest(vertexStart as PortHandle)));
  const perPatch = mul(uint(6), mul(n, n));
  const inLevel = div(local, perPatch);
  const within = sub(local, mul(inLevel, perPatch));
  const quad = div(within, uint(6));
  const corner = sub(within, mul(quad, uint(6)));
  const qy = div(quad, n);
  const qx = sub(quad, mul(qy, n));
  // Two triangles a quad: (0, 0) (0, 1) (1, 1), (0, 0) (1, 1) (1, 0).
  const one = (...corners: number[]) =>
    corners
      .map((c) => select(uint(0), uint(1), equal(corner, uint(c))))
      .reduce((a, b) => add(a, b));
  const x = add(qx, one(2, 4, 5));
  const y = add(qy, one(1, 2, 4));

  // The draw: the patch, and the step of the grid of each edge (2^(level
  // of the patch − level of the edge)), two by channel.
  const slot = add(u32(largest(drawStart as PortHandle)), inLevel);
  const draw = g.call(std.textureLoad, {
    texture: g.texture(PatchValues.draws, { sampleType: 'unfilterable-float' }),
    coords: convert(
      call(std.vec2, {
        x: f32(
          sub(
            slot,
            mul(div(slot, uint(PatchTextureWidth)), uint(PatchTextureWidth)),
          ),
        ),
        y: f32(div(slot, uint(PatchTextureWidth))),
      }),
      BuiltinTypes.vec2i,
    ),
  });
  const steps = (packed: PortHandle) => {
    const value = u32(packed);
    const high = div(value, uint(128));
    return [sub(value, mul(high, uint(128))), high];
  };
  const [bottom, right] = steps(draw.swizzle('y'));
  const [top, left] = steps(draw.swizzle('z'));

  // The points of an edge go to the grid of its level; the corners stay.
  const sx = select(
    select(x, snap(x, top), equal(y, n)),
    snap(x, bottom),
    equal(y, uint(0)),
  );
  const sy = select(
    select(y, snap(y, right), equal(x, n)),
    snap(y, left),
    equal(x, uint(0)),
  );
  const nf = f32(n);
  const s = div(f32(sx), nf);
  const t = div(f32(sy), nf);

  // --- The corners of the patch.
  const patch = u32(draw.swizzle('x'));
  const row = div(patch, uint(PatchesPerRow));
  const first = mul(
    sub(patch, mul(row, uint(PatchesPerRow))),
    uint(TexelsPerPatch),
  );
  const patches = g.texture(PatchValues.patches, {
    sampleType: 'unfilterable-float',
  });
  const texel = (k: number) =>
    g.call(std.textureLoad, {
      texture: patches,
      coords: convert(
        call(std.vec2, { x: f32(add(first, uint(k))), y: f32(row) }),
        BuiltinTypes.vec2i,
      ),
    });
  const texels = [0, 1, 2, 3, 4, 5, 6, 7].map(texel);
  const positions = texels.slice(0, 4).map((c) => c.swizzle('xyz'));
  const normals = texels.slice(4).map((c) => c.swizzle('xyz'));
  const uvs = [0, 1, 2, 3].map((c) =>
    call(std.vec2, {
      x: texels[c].swizzle('w'),
      y: texels[c + 4].swizzle('w'),
    }),
  );

  // a (1 − w) + b w: exactly a at 0 and b at 1, so that two patches agree
  // to the bit on their common edge.
  const lerp = (a: Value, b: Value, w: Value) =>
    add(mul(a, sub(1, w)), mul(b, w));
  const bilinear = ([c00, c10, c01, c11]: Value[]) =>
    lerp(lerp(c00, c10, s), lerp(c01, c11, s), t);
  const base = bilinear(positions);
  const uv = bilinear(uvs);
  const baseNormal = call(std.normalize, { x: bilinear(normals) });

  let position = base;
  let normal = baseNormal;
  let height: PortHandle = g.constant(BuiltinTypes.f32, 0);
  const displacement = options.displacement;
  if (displacement) {
    const scale = displacement.scale ?? 0.1;
    const bias = displacement.bias ?? 0;
    const step = displacement.texel ?? 1 / 256;
    const heightAt = (at: Value) =>
      g
        .call(std.textureSampleLevel, {
          texture: displacement.texture,
          sampler: displacement.sampler,
          uv: at,
          level: 0,
        })
        .swizzle('x');
    height = heightAt(uv);
    position = add(base, mul(baseNormal, mul(add(height, bias), scale)));

    // The slope of the height in uv, then along s and t; the tangents of
    // the displaced surface, and their cross product.
    const offset = (dx: number, dy: number) =>
      add(uv, mul(call(std.vec2, { x: dx, y: dy }), step));
    const slope = div(
      call(std.vec2, {
        x: sub(heightAt(offset(1, 0)), heightAt(offset(-1, 0))),
        y: sub(heightAt(offset(0, 1)), heightAt(offset(0, -1))),
      }),
      typeof step === 'number' ? step * 2 : mul(step, 2),
    );
    const [p00, p10, p01, p11] = positions;
    const [uv00, uv10, uv01, uv11] = uvs;
    const alongS = lerp(sub(p10, p00), sub(p11, p01), t);
    const alongT = lerp(sub(p01, p00), sub(p11, p10), s);
    const uvS = lerp(sub(uv10, uv00), sub(uv11, uv01), t);
    const uvT = lerp(sub(uv01, uv00), sub(uv11, uv10), s);
    const tangent = (along: Value, uvAlong: Value) =>
      add(
        along,
        mul(baseNormal, mul(call(std.dot, { a: slope, b: uvAlong }), scale)),
      );
    normal = call(std.normalize, {
      x: call(std.cross, { a: tangent(alongT, uvT), b: tangent(alongS, uvS) }),
    });
  }

  g.vertexAttribute('position', position);
  g.vertexAttribute('normal', normal);
  g.vertexAttribute('uv', uv);
  const level = sub(reachedLevels as PortHandle, 1);
  return { position, normal, uv, height, level };
}
