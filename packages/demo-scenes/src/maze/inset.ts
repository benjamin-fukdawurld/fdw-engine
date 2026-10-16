import type { Surface } from '@fdw/engine-backend';
import type { RenderGraph, TextureHandle } from '@fdw/engine-core';
import {
  BuiltinTypes,
  GraphBuilder,
  MaterialGraphData,
  PortHandle,
  std,
} from '@fdw/engine-shader';

/**
 * A picture drawn over the main view, in a corner of the screen: the top
 * view of the culling, or the map.
 */
export interface Inset {
  /**
   * Adds its passes to a graph, over `target` (the main view, already
   * added): returns the version of the target it writes.
   */
  add(
    graph: RenderGraph,
    target: TextureHandle,
    surface: Surface,
  ): TextureHandle;
}

// A frame around the picture, in uv.
const border = 0.004;

/**
 * The graph of a fullscreen material drawing a picture in a rectangle of
 * the screen (the `rect` uniform: x, y, width, height in screen uv), a
 * dark frame around it, transparent elsewhere. `content` gives the color
 * of a pixel from where it is in the rectangle, from 0 to 1.
 */
export function insetGraph(
  name: string,
  content: (g: GraphBuilder, local: PortHandle) => PortHandle,
): MaterialGraphData {
  const g = new GraphBuilder(name);
  const uv = g.builtin('screen-uv');
  const rect = g.uniform('rect', BuiltinTypes.vec4f);
  // Where the pixel is in the rectangle, from 0 to 1.
  const local = g.call(std.div, {
    a: g.call(std.sub, { a: uv, b: rect.swizzle('xy') }),
    b: rect.swizzle('zw'),
  });
  // 1 between low and high, on both axes.
  const within = (low: number, high: number) =>
    g.call(std.mul, {
      a: g.call(std.mul, {
        a: g.call(std.step, { edge: low, x: local.swizzle('x') }),
        b: g.call(std.step, { edge: local.swizzle('x'), x: high }),
      }),
      b: g.call(std.mul, {
        a: g.call(std.step, { edge: low, x: local.swizzle('y') }),
        b: g.call(std.step, { edge: local.swizzle('y'), x: high }),
      }),
    });
  const inside = within(0, 1);
  const frame = within(-border * 4, 1 + border * 4);
  g.fullscreen({
    color: g.call(std.extend, {
      xyz: g.call(std.mul, { a: content(g, local), b: inside }),
      w: g.call(std.max, {
        a: inside,
        b: g.call(std.mul, { a: frame, b: 0.8 }),
      }),
    }),
  });
  return g.build();
}

/** The rectangle of a square inset in the top right corner: 35 % high. */
export function insetRect(surface: Surface): {
  size: number;
  rect: [number, number, number, number];
} {
  const size = Math.round(Math.min(surface.width, surface.height) * 0.35);
  // A margin of 2 % around.
  const margin = 0.02;
  const width = size / surface.width;
  const height = size / surface.height;
  return { size, rect: [1 - width - margin, margin, width, height] };
}
