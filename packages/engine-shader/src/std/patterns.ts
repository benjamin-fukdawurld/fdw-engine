import { defineFunction } from '../graph/functions';
import { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import type { FunctionDefinition } from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { BuiltinTypes } from '../types/ShaderType';
import { Ops } from './ops';

// The patterns of the standard library, as function graphs: checkers,
// stripes, bricks and tiles, from a uv (any 2d coordinates: a mesh uv, a
// world position, a triplanar plane). The filtered ones average the
// pattern over the pixel, from the screen space derivatives of their
// coordinates: no aliasing however small the pattern on the screen, but
// in the fragment stage only.

const vec2 = BuiltinTypes.vec2f;
const f32 = BuiltinTypes.f32;

/** The pattern functions of the standard library. */
export function createPatternFunctions(
  registry: NodeRegistry,
): FunctionDefinition[] {
  const define = (
    id: string,
    description: string,
    build: (f: GraphBuilder, o: Ops) => void,
  ) => {
    const f = new GraphBuilder(id, registry);
    build(f, new Ops(f));
    return defineFunction(f.build(), { id, description, registry });
  };
  // The width of a pixel in the units of a value: the largest of its
  // screen space derivatives (a little more than 0: no division by 0).
  const pixelWidth = (o: Ops, value: PortHandle) =>
    o.add(o.max(o.abs(o.dpdx(value)), o.abs(o.dpdy(value))), 1e-4);

  // The cells of a grid of cells of `size` (the bricks, the tiles): the
  // position in the cell from 0 to 1, the integer coordinates of the cell,
  // the distance to its border. `offset`: the shift of each row, in cells.
  const grid = (
    o: Ops,
    uv: PortHandle,
    size: PortHandle,
    offset: PortHandle | number,
  ) => {
    const scaled = o.div(uv, size);
    const row = o.floor(scaled.swizzle('y'));
    const x = o.add(scaled.swizzle('x'), o.mul(offset, row));
    const cell = o.vec2(o.floor(x), row);
    const local = o.vec2(o.fract(x), o.fract(scaled.swizzle('y')));
    return { cell, local };
  };
  // The outputs of the grid patterns: mask from the distance to the
  // border (> 0 inside), softened over the bevel.
  const gridOutputs = (
    f: GraphBuilder,
    o: Ops,
    {
      edge,
      local,
      cell,
      bevel,
    }: {
      edge: PortHandle;
      local: PortHandle;
      cell: PortHandle;
      bevel: PortHandle;
    },
  ) => {
    f.functionOutput('mask', o.smoothstep(0, o.max(bevel, 1e-5), edge));
    f.functionOutput('local', local);
    f.functionOutput('cell', cell);
    f.functionOutput('edge', edge);
  };

  return [
    define(
      'pattern.checker',
      'A checkerboard of unit squares: 0 on the squares whose integer coordinates add up to an even number, 1 on the others.',
      (f, o) => {
        const cell = o.floor(f.functionInput('uv', vec2));
        f.functionOutput(
          'value',
          o.mul(
            o.fract(o.mul(o.add(cell.swizzle('x'), cell.swizzle('y')), 0.5)),
            2,
          ),
        );
      },
    ),
    // The box filter of the checkerboard over the pixel (I. Quilez): the
    // integral of the square wave of each axis over the width of the pixel.
    define(
      'pattern.checkerFiltered',
      'pattern.checker averaged over the pixel: gray where the squares are smaller than the pixel. Fragment stage only.',
      (f, o) => {
        const uv = f.functionInput('uv', vec2);
        const w = pixelWidth(o, uv);
        const triangle = (x: PortHandle) =>
          o.abs(o.sub(o.fract(o.mul(x, 0.5)), 0.5));
        const half = o.mul(w, 0.5);
        const wave = o.div(
          o.mul(o.sub(triangle(o.sub(uv, half)), triangle(o.add(uv, half))), 2),
          w,
        );
        f.functionOutput(
          'value',
          o.sub(0.5, o.mul(o.mul(wave.swizzle('x'), wave.swizzle('y')), 0.5)),
        );
      },
    ),
    define(
      'pattern.stripes',
      'Stripes across x: 1 on the first `width` of each unit (0.5: as wide as the gaps), 0 elsewhere.',
      (f, o) => {
        const x = f.functionInput('x', f32);
        const width = f.functionInput('width', f32, { default: 0.5 });
        f.functionOutput('value', o.sub(1, o.step(width, o.fract(x))));
      },
    ),
    // The integral of the stripes, floor(x) × width + min(fract(x), width),
    // differentiated over the pixel.
    define(
      'pattern.stripesFiltered',
      'pattern.stripes averaged over the pixel. Fragment stage only.',
      (f, o) => {
        const x = f.functionInput('x', f32);
        const width = f.functionInput('width', f32, { default: 0.5 });
        const w = pixelWidth(o, x);
        const integral = (at: PortHandle) =>
          o.add(o.mul(o.floor(at), width), o.min(o.fract(at), width));
        const half = o.mul(w, 0.5);
        f.functionOutput(
          'value',
          o.div(o.sub(integral(o.add(x, half)), integral(o.sub(x, half))), w),
        );
      },
    ),
    define(
      'pattern.bricks',
      'Bricks of `size` in rows shifted by `offset` (0.5: half a brick), in a mortar of `mortar` (in the units of uv). mask: 1 on the bricks, 0 in the mortar, softened over `bevel`; local: the position in the brick from 0 to 1; cell: the integer column and row of the brick (noise.random2 gives it a color); edge: the distance to the mortar.',
      (f, o) => {
        const uv = f.functionInput('uv', vec2);
        const size = f.functionInput('size', vec2, { default: [0.25, 0.08] });
        const mortar = f.functionInput('mortar', f32, { default: 0.01 });
        const offset = f.functionInput('offset', f32, { default: 0.5 });
        const bevel = f.functionInput('bevel', f32, { default: 0.005 });
        const { cell, local } = grid(o, uv, size, offset);
        // The distance to the nearest side, in the units of uv.
        const sides = o.mul(o.min(local, o.sub(1, local)), size);
        const edge = o.sub(
          o.min(sides.swizzle('x'), sides.swizzle('y')),
          o.mul(mortar, 0.5),
        );
        gridOutputs(f, o, { edge, local, cell, bevel });
      },
    ),
    define(
      'pattern.tiles',
      'Square tiles of `size` with rounded corners (`radius`), separated by `gap` (in the units of uv). Outputs as pattern.bricks.',
      (f, o) => {
        const uv = f.functionInput('uv', vec2);
        const size = f.functionInput('size', vec2, { default: [0.2, 0.2] });
        const gap = f.functionInput('gap', f32, { default: 0.01 });
        const radius = f.functionInput('radius', f32, { default: 0.02 });
        const bevel = f.functionInput('bevel', f32, { default: 0.005 });
        const { cell, local } = grid(o, uv, size, 0);
        // A rounded box: the signed distance to its border, < 0 inside.
        const p = o.mul(o.sub(local, 0.5), size);
        const half = o.sub(o.mul(size, 0.5), o.mul(gap, 0.5));
        const q = o.add(o.sub(o.abs(p), half), radius);
        const outside = o.length(o.max(q, 0));
        const inside = o.min(o.max(q.swizzle('x'), q.swizzle('y')), 0);
        const edge = o.mul(o.sub(o.add(outside, inside), radius), -1);
        gridOutputs(f, o, { edge, local, cell, bevel });
      },
    ),
  ];
}
