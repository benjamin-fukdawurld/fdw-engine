import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import {
  axisAngle,
  createCube,
  createPlane,
  createSphere,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Transparent and masked materials: three colored panes of glass, sorted
// from back to front as the camera turns around them; a double-sided glass
// ball, whose inside shows through; a masked fence, with holes in its
// shadow; and two crossing panes, which no order can draw right.
const example: Example = ({ backend, surface, onFrame }) => {
  // --- Glass: a color and an opacity (alpha), blended over what is behind.
  const glassGraph = (() => {
    const g = new GraphBuilder('glass');
    const color = g.uniform('color', BuiltinTypes.vec4f);
    g.surface({
      shadingModel: 'phong',
      baseColor: color.swizzle('rgb'),
      alpha: color.swizzle('a'),
      shininess: 64,
    });
    return g.build();
  })();
  const glass = (
    color: [number, number, number, number],
    doubleSided = false
  ) =>
    new Material({
      graph: glassGraph,
      values: { color },
      renderState: { alphaMode: 'blend', doubleSided },
    });

  // --- The fence: a texture whose alpha is 0 in the holes. Masked: the
  // fragments below the cutoff are discarded, the others are opaque.
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Diagonal bars, 1/4 of the period wide, in both directions.
      const a = ((x + y) % 16) / 16;
      const b = ((x - y + size) % 16) / 16;
      const bar = a < 0.25 || b < 0.25;
      pixels.set([90, 140, 60, bar ? 255 : 0], (y * size + x) * 4);
    }
  }
  const fenceMap = backend.textures.createTexture({
    type: '2d',
    format: 'rgba8unorm',
    dimensions: { width: size, height: size },
    source: pixels,
  });
  const f = new GraphBuilder('fence');
  const texel = f.call(std.textureSample, {
    texture: f.texture('map'),
    sampler: f.sampler('mapSampler'),
    uv: f.call(std.mul, { a: f.attribute('uv', BuiltinTypes.vec2f), b: 2 }),
  });
  f.surface({
    shadingModel: 'phong',
    baseColor: texel.swizzle('rgb'),
    alpha: texel.swizzle('a'),
  });
  const fence = new Material({
    graph: f.build(),
    values: {
      map: fenceMap,
      mapSampler: backend.textures.createSampler({
        wrapModeS: 'repeat',
        wrapModeT: 'repeat',
      }),
      // The default: discarded below 0.5.
      alphaCutoff: 0.5,
    },
    // Seen from both sides.
    renderState: { alphaMode: 'mask', doubleSided: true },
  });

  const g = new GraphBuilder('ground');
  g.surface({
    shadingModel: 'phong',
    baseColor: [0.6, 0.58, 0.55],
    specular: [0.1, 0.1, 0.1],
  });
  const ground = new Material({ graph: g.build() });

  // --- The scene.
  const cube = createCube();
  const sphere = createSphere(48, 24);
  const plane = createPlane();
  // A pane: a thin box.
  const pane = (x: number, z: number, angle = 0) =>
    new Transform({
      position: { x, y: 0.7, z },
      rotation: axisAngle(0, 1, 0, angle),
      scale: { x: 1, y: 1.4, z: 0.04 },
    });
  const items = [
    {
      mesh: cube,
      material: ground,
      transform: new Transform({
        position: { x: 0, y: -0.05, z: 0 },
        scale: { x: 8, y: 0.1, z: 6 },
      }),
    },
    // Three panes one behind the other.
    {
      mesh: cube,
      material: glass([1, 0.2, 0.2, 0.4]),
      transform: pane(-1.6, 0.6),
    },
    {
      mesh: cube,
      material: glass([0.2, 1, 0.2, 0.4]),
      transform: pane(-1.3, 0),
    },
    {
      mesh: cube,
      material: glass([0.2, 0.4, 1, 0.4]),
      transform: pane(-1, -0.6),
    },
    // A double-sided ball: its back faces, then its front faces.
    {
      mesh: sphere,
      material: glass([1, 0.85, 0.3, 0.35], true),
      transform: new Transform({
        position: { x: 0.4, y: 0.6, z: 0.6 },
        scale: { x: 1.2, y: 1.2, z: 1.2 },
      }),
    },
    // The fence, standing: a plane turned to face +z.
    {
      mesh: plane,
      material: fence,
      transform: new Transform({
        position: { x: 0.6, y: 0.8, z: -1.4 },
        rotation: axisAngle(1, 0, 0, Math.PI / 2),
        scale: { x: 2, y: 1.6, z: 1.6 },
      }),
    },
    // Two crossing panes: one is in front of the other on each side of the
    // crossing, but they are sorted as wholes.
    {
      mesh: cube,
      material: glass([1, 0.5, 0, 0.5]),
      transform: pane(2, -0.2, Math.PI / 4),
    },
    {
      mesh: cube,
      material: glass([0.6, 0.2, 1, 0.5]),
      transform: pane(2, -0.2, -Math.PI / 4),
    },
  ];

  const sun = new DirectionalLight({
    direction: { x: -0.4, y: -1, z: 0.6 },
    ambient: { x: 0.3, y: 0.3, z: 0.3 },
    diffuse: { x: 0.6, y: 0.6, z: 0.6 },
    castShadow: true,
  });
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 50,
    },
  });
  const renderer = new Renderer(backend);

  onFrame((time) => {
    // The camera turns around the scene: the order of the panes changes.
    const yaw = 0.6 * Math.sin(time * 0.3);
    const pitch = -0.45;
    camera.position = {
      x: 5.5 * Math.sin(yaw),
      y: 2.6,
      z: 5.5 * Math.cos(yaw),
    };
    // Yaw around y, then pitch around the x axis of the camera.
    const q1 = axisAngle(0, 1, 0, yaw);
    const q2 = axisAngle(1, 0, 0, pitch);
    camera.rotation = {
      x: q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
      y: q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
      z: q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,
      w: q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z,
    };
    renderer.render({
      items,
      camera,
      surface,
      lights: [sun],
      clearColor: { r: 0.55, g: 0.7, b: 0.85, a: 1 },
    });
  });
};

export default example;
