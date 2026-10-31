import {
  Camera,
  DirectionalLight,
  Environment,
  Material,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import {
  BuiltinTypes,
  defineFunction,
  GraphBuilder,
  Ops,
  std,
  stdMapping,
} from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Spheres from smooth to rough, dielectric and metal, lit by a sky: its
// light comes from every direction (image-based lighting), and the sun
// casts the shadows.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
    samples: 4,
  });

  // The sky: a function of the direction, in linear colors. A gradient, a
  // dark ground, and a sun much brighter than the rest.
  const sunDirection = [0.55, 0.45, 0.7];
  const f = new GraphBuilder('sky');
  const o = new Ops(f);
  const d = f.functionInput('direction', BuiltinTypes.vec3f);
  const up = d.swizzle('y');
  const sky = o.mix(
    [0.55, 0.65, 0.8],
    [0.12, 0.25, 0.6],
    o.sqrt(o.saturate(up)),
  );
  const ground = o.mix(
    [0.35, 0.33, 0.3],
    [0.08, 0.07, 0.06],
    o.saturate(o.mul(up, -6)),
  );
  const toSun = o.max(o.dot(d, sunDirection), 0);
  const sun = o.mul(
    [1, 0.9, 0.75],
    o.add(o.mul(o.pow(toSun, 2000), 60), o.mul(o.pow(toSun, 40), 0.8)),
  );
  f.functionOutput(
    'color',
    o.add(o.select(ground, sky, o.greater(up, 0)), sun),
  );
  const skyFunction = defineFunction(f.build(), { id: 'example.sky' });
  const environment = new Environment({ sky: skyFunction });

  // The materials: the values are uniforms.
  const g = new GraphBuilder('pbr');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
    metallic: g.uniform('metallic', BuiltinTypes.f32),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
  });
  const graph = g.build();
  const material = (
    baseColor: [number, number, number],
    metallic: number,
    roughness: number,
  ) => new Material({ graph, values: { baseColor, metallic, roughness } });

  const sphere = createSphere(48, 24);
  const items: RenderItem[] = [
    {
      mesh: createCube(),
      material: material([0.3, 0.3, 0.3], 0, 0.8),
      transform: new Transform({
        position: { y: -0.55 },
        scale: { x: 14, y: 0.1, z: 8 },
      }),
    },
  ];
  // Two rows: a red dielectric, then gold; the roughness from 0 to 1.
  for (let i = 0; i < 6; i++) {
    const roughness = i / 5;
    items.push(
      {
        mesh: sphere,
        material: material([0.8, 0.12, 0.08], 0, roughness),
        transform: new Transform({
          position: { x: (i - 2.5) * 1.6, z: 1.2 },
          scale: { x: 0.65, y: 0.65, z: 0.65 },
        }),
      },
      {
        mesh: sphere,
        material: material([1, 0.78, 0.34], 1, roughness),
        transform: new Transform({
          position: { x: (i - 2.5) * 1.6, z: -1.2 },
          scale: { x: 0.65, y: 0.65, z: 0.65 },
        }),
      },
    );
  }
  // The sky behind: a sphere around the camera, showing the same function.
  const s = new GraphBuilder('sky dome');
  const view = s.call(std.normalize, {
    x: s.call(std.sub, {
      a: s.call(stdMapping.worldPosition),
      b: s.engine('camera.position'),
    }),
  });
  s.surface({ baseColor: s.call(skyFunction, { direction: view }) });
  const dome: RenderItem = {
    mesh: sphere,
    material: new Material({
      graph: s.build(),
      renderState: { doubleSided: true },
    }),
    transform: new Transform({ scale: { x: 90, y: 90, z: 90 } }),
    castShadow: false,
  };
  items.push(dome);

  // The sun of the sky, casting the shadows the environment does not.
  const sunLight = new DirectionalLight({
    direction: {
      x: -sunDirection[0],
      y: -sunDirection[1],
      z: -sunDirection[2],
    },
    ambient: { x: 0, y: 0, z: 0 },
    diffuse: { x: 1.6, y: 1.45, z: 1.25 },
    specular: { x: 1.6, y: 1.45, z: 1.25 },
    castShadow: true,
  });

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 200,
    },
  });

  // E: the environment on and off.
  let lit = true;
  canvas.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyE') return;
    lit = !lit;
    event.preventDefault();
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());

  onFrame((time) => {
    const around = 0.3 * Math.sin(time * 0.2);
    camera.position = {
      x: Math.sin(around) * 6.5,
      y: 1.7,
      z: Math.cos(around) * 6.5,
    };
    camera.rotation = multiply(
      axisAngle(0, 1, 0, around),
      axisAngle(1, 0, 0, -0.2),
    );
    dome.transform.position = camera.position;
    renderer.render({
      items,
      camera,
      surface,
      lights: [sunLight],
      ...(lit ? { environment } : {}),
    });
    info(`environment ${lit ? 'on' : 'off'} (E)`);
  });
};

// The product of two rotations (quaternions as { x, y, z, w }).
function multiply(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export default example;
