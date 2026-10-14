import {
  BuiltinTypes,
  GraphBuilder,
  MaterialGraphData,
  PortHandle,
  std,
} from '@fdw/engine-shader';

// The graphs of the full screen passes of the occlusion culling. They read
// textures by their texels (textureLoad): the levels of the pyramid are
// r32float, which cannot be filtered everywhere.

type Value = PortHandle | number | readonly number[];

const { add, sub, mul, div, min, max, floor } = std;

const call = (
  g: GraphBuilder,
  fn: typeof std.add,
  a: Value,
  b: Value
): PortHandle => g.call(fn, { a, b } as never);

const toInt = (g: GraphBuilder, value: PortHandle) =>
  g.call(std.convert, { value }, { params: { to: BuiltinTypes.vec2i } });

// The texel of the target a fragment writes: floor(screen-uv × size).
const pixelOf = (g: GraphBuilder, size: PortHandle) =>
  g.call(floor, { x: call(g, mul, g.builtin('screen-uv'), size) });

// The farthest of the 2 × 2 texels of the source under a texel of a level,
// clamped to the source (a level has half its size, rounded up: the last
// texel of an odd row covers one texel only).
function farthestOf(
  g: GraphBuilder,
  read: (coords: PortHandle) => PortHandle
): PortHandle {
  const size = g.uniform('size', BuiltinTypes.vec2f);
  const last = call(g, sub, g.uniform('sourceSize', BuiltinTypes.vec2f), 1);
  const first = call(g, mul, pixelOf(g, size), 2);
  let farthest: PortHandle | undefined;
  for (const offset of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const depth = read(
      toInt(g, call(g, min, call(g, add, first, offset), last))
    );
    farthest = farthest ? call(g, max, farthest, depth) : depth;
  }
  return farthest as PortHandle;
}

const write = (g: GraphBuilder, value: PortHandle) =>
  g.fullscreen({ color: g.call(std.vec4, { x: value, w: 1 }) });

/**
 * The first level of the pyramid: for each texel, the farthest of 2 × 2
 * pixels of the depth buffer ('depth'), as a distance along the axis of
 * the camera (the depths of the buffer are not linear).
 */
export function firstLevelGraph(): MaterialGraphData {
  const g = new GraphBuilder('occlusion pyramid, first level');
  const depth = g.texture('depth', { sampleType: 'depth' });
  const farthest = farthestOf(g, (coords) =>
    g.call(std.textureLoadDepth, { texture: depth, coords })
  );
  // The point of the view at that depth, on the axis.
  const point = g.call(std.transform, {
    matrix: g.uniform('inverseProjection', BuiltinTypes.mat4f),
    vector: g.call(std.vec4, { z: farthest, w: 1 }),
  });
  write(
    g,
    call(g, div, call(g, mul, point.swizzle('z'), -1), point.swizzle('w'))
  );
  return g.build();
}

/** A level of the pyramid from the previous one ('source'). */
export function nextLevelGraph(): MaterialGraphData {
  const g = new GraphBuilder('occlusion pyramid, next level');
  const source = g.texture('source', { sampleType: 'unfilterable-float' });
  write(
    g,
    farthestOf(g, (coords) =>
      g.call(std.textureLoad, { texture: source, coords }).swizzle('r')
    )
  );
  return g.build();
}

/** The name of the texture of a level of the pyramid in the test graph. */
export const levelName = (level: number) => `level${level}`;

/**
 * The test of the boxes against a pyramid of `levels` levels: a texel per
 * box, 1 where it may be visible, 0 where the opaque items hide it. The
 * boxes are in 'bounds', two texels each (min, max: x, y, z in the world),
 * the box of the texel (x, y) at (2x, y) and (2x + 1, y).
 *
 * The box is projected (its 8 corners) to a rectangle of pixels of the depth
 * buffer, and its nearest point to a distance along the axis of the camera.
 * The finest level where the rectangle spans at most 2 × 2 texels gives the
 * farthest depth of the opaque items over it: the box is hidden when its
 * nearest point is farther. Boxes crossing the near plane are visible.
 */
export function testGraph(levels: number): MaterialGraphData {
  const g = new GraphBuilder(`occlusion test, ${levels} levels`);
  const view = g.uniform('view', BuiltinTypes.mat4f);
  const viewProjection = g.uniform('viewProjection', BuiltinTypes.mat4f);
  const depthSize = g.uniform('depthSize', BuiltinTypes.vec2f);
  const near = g.uniform('near', BuiltinTypes.f32);
  const margin = g.uniform('margin', BuiltinTypes.f32);
  const bounds = g.texture('bounds', { sampleType: 'unfilterable-float' });

  const texel = pixelOf(g, g.uniform('slots', BuiltinTypes.vec2f));
  const corner = (dx: number) =>
    g
      .call(std.textureLoad, {
        texture: bounds,
        coords: toInt(
          g,
          g.call(std.vec2, {
            x: call(g, add, call(g, mul, texel.swizzle('x'), 2), dx),
            y: texel.swizzle('y'),
          })
        ),
      })
      .swizzle('xyz');
  const low = corner(0);
  const high = corner(1);

  let nearest: PortHandle | undefined;
  let lowNdc: PortHandle | undefined;
  let highNdc: PortHandle | undefined;
  for (let i = 0; i < 8; i++) {
    const pick = (bit: number, axis: 'x' | 'y' | 'z') =>
      (i & bit ? high : low).swizzle(axis);
    const point = g.call(std.vec4, {
      x: pick(1, 'x'),
      y: pick(2, 'y'),
      z: pick(4, 'z'),
      w: 1,
    });
    // The distance along the axis of the camera, which looks at -z.
    const distance = call(
      g,
      mul,
      g.call(std.transform, { matrix: view, vector: point }).swizzle('z'),
      -1
    );
    const clip = g.call(std.transform, {
      matrix: viewProjection,
      vector: point,
    });
    const ndc = call(g, div, clip.swizzle('xy'), clip.swizzle('w'));
    nearest = nearest ? call(g, min, nearest, distance) : distance;
    lowNdc = lowNdc ? call(g, min, lowNdc, ndc) : ndc;
    highNdc = highNdc ? call(g, max, highNdc, ndc) : ndc;
  }
  const lowest = lowNdc as PortHandle;
  const highest = highNdc as PortHandle;

  // The rectangle of pixels, y down.
  const lastPixel = call(g, sub, depthSize, 1);
  const pixels = (x: PortHandle, y: PortHandle) =>
    g.call(std.clamp, {
      x: g.call(floor, {
        x: call(
          g,
          mul,
          call(
            g,
            add,
            call(g, mul, g.call(std.vec2, { x, y }), [0.5, -0.5]),
            0.5
          ),
          depthSize
        ),
      }),
      low: [0, 0],
      high: lastPixel,
    });
  const first = pixels(lowest.swizzle('x'), highest.swizzle('y'));
  const last = pixels(highest.swizzle('x'), lowest.swizzle('y'));

  // The farthest depth over the rectangle, from the coarsest level (one
  // texel) to the finest one where it spans 2 × 2 texels at most.
  let farthest: PortHandle | undefined;
  for (let level = levels - 1; level >= 0; level--) {
    const texture = g.texture(levelName(level), {
      sampleType: 'unfilterable-float',
    });
    // A texel of the level covers 2^(level + 1) pixels of the depth.
    const scale = 2 ** (level + 1);
    const from = g.call(floor, { x: call(g, div, first, scale) });
    const to = g.call(floor, { x: call(g, div, last, scale) });
    let depth: PortHandle | undefined;
    for (const [x, y] of [
      [from, from],
      [to, from],
      [from, to],
      [to, to],
    ]) {
      const value = g
        .call(std.textureLoad, {
          texture,
          coords: toInt(
            g,
            g.call(std.vec2, { x: x.swizzle('x'), y: y.swizzle('y') })
          ),
        })
        .swizzle('r');
      depth = depth ? call(g, max, depth, value) : value;
    }
    if (!farthest) {
      farthest = depth as PortHandle;
      continue;
    }
    const span = call(g, sub, to, from);
    farthest = g.call(std.select, {
      ifFalse: farthest,
      ifTrue: depth as PortHandle,
      condition: g.call(std.lessEqual, {
        a: call(g, max, span.swizzle('x'), span.swizzle('y')),
        b: 1,
      }),
    });
  }

  const hidden = g.call(std.greater, {
    a: nearest as PortHandle,
    b: call(g, mul, farthest as PortHandle, call(g, add, margin, 1)),
  });
  const crossesNear = g.call(std.lessEqual, {
    a: nearest as PortHandle,
    b: near,
  });
  const visible = g.call(std.select, {
    ifFalse: g.call(std.select, { ifFalse: 1, ifTrue: 0, condition: hidden }),
    ifTrue: 1,
    condition: crossesNear,
  });
  write(g, visible);
  return g.build();
}
