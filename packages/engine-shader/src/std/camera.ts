import { defineFunction } from '../graph/functions';
import { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import type { FunctionDefinition } from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { BuiltinTypes } from '../types/ShaderType';
import * as functions from './functions';

// The point of the world seen at a position of the screen, at a depth along
// the axis of the camera (the 'view-depth' output of the scene passes): for
// the full screen passes that light or reflect the scene. The two ends of
// the ray of the pixel, on the near and far planes, come from the inverse of
// the view projection; the point is between them, in proportion of its
// depth. Perspective and orthographic cameras alike.
function positionFromDepth(registry: NodeRegistry): FunctionDefinition {
  const f = new GraphBuilder('camera.positionFromDepth', registry);
  const { sub, mul, div, mix, transform, extend } = functions;
  const uv = f.functionInput('uv', BuiltinTypes.vec2f);
  const viewDepth = f.functionInput('viewDepth', BuiltinTypes.f32);
  // From [0, 1] (y down) to [-1, 1] (y up).
  const ndc = f.call(mul, {
    a: f.call(sub, { a: f.call(mul, { a: uv, b: 2 }), b: 1 }),
    b: [1, -1],
  });
  const inverse = f.engine('camera.inverseViewProjection');
  const view = f.engine('camera.view');
  // The point of the ray at a depth of the clip space: 0 near, 1 far.
  const unproject = (z: number) => {
    const clip = f.call(functions.vec4, {
      x: ndc.swizzle('x'),
      y: ndc.swizzle('y'),
      z,
      w: 1,
    });
    const point = f.call(transform, { matrix: inverse, vector: clip });
    return f.call(div, { a: point.swizzle('xyz'), b: point.swizzle('w') });
  };
  // Its depth along the axis of the camera, which looks at -z.
  const depthOf = (point: PortHandle) =>
    f.call(mul, {
      a: f
        .call(transform, {
          matrix: view,
          vector: f.call(extend, { xyz: point, w: 1 }),
        })
        .swizzle('z'),
      b: -1,
    });
  const near = unproject(0);
  const far = unproject(1);
  const nearDepth = depthOf(near);
  const t = f.call(div, {
    a: f.call(sub, { a: viewDepth, b: nearDepth }),
    b: f.call(sub, { a: depthOf(far), b: nearDepth }),
  });
  f.functionOutput('position', f.call(mix, { a: near, b: far, t }));
  return defineFunction(f.build(), {
    id: 'camera.positionFromDepth',
    description:
      'The world position seen at a screen uv, at a depth along the axis of the camera (view-depth).',
    registry,
  });
}

/**
 * The camera functions of the standard library, built with the given
 * registry: `camera.positionFromDepth`.
 */
export function createCameraFunctions(
  registry: NodeRegistry
): FunctionDefinition[] {
  return [positionFromDepth(registry)];
}
