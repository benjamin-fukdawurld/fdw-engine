import {
  Camera,
  DirectionalLight,
  Material,
  PointLight,
  Renderer,
  Transform,
  computeTangents,
} from '@fdw/engine-core';
import { fullMipLevelCount } from '@fdw/engine-backend';
import { BuiltinTypes, GraphBuilder, std, stdMacros } from '@fdw/engine-shader';
import type { PortHandle } from '@fdw/engine-shader';
import { axisAngle, createPlane } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// The same brick wall with the four techniques that add detail to a flat
// surface: normal mapping, bump mapping, parallax occlusion mapping and
// displacement mapping. Click to see the flat surface without them.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // --- The textures, computed here: the height of the bricks (1 on the
  // bricks, 0 in the mortar, beveled edges), the normal map derived from
  // it, and the colors.
  const size = 128;
  const height = new Float32Array(size * size);
  const color = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 4 rows of 2 bricks, every other row shifted by half a brick.
      const row = Math.floor((y / size) * 4);
      const u = (x / size) * 2 + (row % 2) * 0.5;
      const brick = Math.floor(u);
      const fx = u - brick;
      const fy = (y / size) * 4 - row;
      // The distance to the closest joint, in fractions of a brick height.
      const edge = Math.min(fx * 2, (1 - fx) * 2, fy, 1 - fy);
      const bevel = Math.min(Math.max((edge - 0.06) / 0.12, 0), 1);
      const value = Math.sin((bevel * Math.PI) / 2);
      height[y * size + x] = value;
      const shade = 0.75 + 0.25 * Math.sin(brick * 12.9 + row * 78.2);
      color.set(
        value > 0
          ? [Math.round(170 * shade), Math.round(70 * shade), 50, 255]
          : [150, 145, 135, 255],
        (y * size + x) * 4
      );
    }
  }
  const heightPixels = new Uint8Array(size * size * 4);
  const normalPixels = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) =>
    height[((y + size) % size) * size + ((x + size) % size)];
  const slope = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = Math.round(at(x, y) * 255);
      heightPixels.set([h, h, h, 255], (y * size + x) * 4);
      // The normal in the tangent frame: x along u, y up in the image (the
      // OpenGL convention), z out of the surface.
      const dx = (at(x + 1, y) - at(x - 1, y)) * slope;
      const dy = (at(x, y - 1) - at(x, y + 1)) * slope;
      const length = Math.hypot(dx, dy, 1);
      normalPixels.set(
        [-dx / length, -dy / length, 1 / length].map((n) =>
          Math.round((n * 0.5 + 0.5) * 255)
        ),
        (y * size + x) * 4
      );
      normalPixels[(y * size + x) * 4 + 3] = 255;
    }
  }
  const texture = (
    pixels: Uint8Array,
    format: 'rgba8unorm' | 'rgba8unorm-srgb'
  ) =>
    backend.textures.createTexture({
      type: '2d',
      format,
      dimensions: { width: size, height: size },
      mipLevelCount: fullMipLevelCount({ width: size, height: size }),
      source: pixels,
    });
  const textures = {
    colorMap: texture(color, 'rgba8unorm-srgb'),
    normalMap: texture(normalPixels, 'rgba8unorm'),
    heightMap: texture(heightPixels, 'rgba8unorm'),
  };
  const sampler = backend.textures.createSampler({
    wrapModeS: 'repeat',
    wrapModeT: 'repeat',
    maxAnisotropy: 8,
  });
  const values = {
    ...textures,
    colorSampler: sampler,
    normalSampler: sampler,
    heightSampler: sampler,
  };

  // --- The materials: the same textures, read with each technique. The
  // wall repeats them twice across.
  type Technique = 'flat' | 'normal' | 'bump' | 'parallax' | 'displacement';
  const material = (technique: Technique) => {
    const g = new GraphBuilder(technique);
    const read = (name: string, uv: PortHandle) =>
      g.call(std.textureSample, {
        texture: g.texture(`${name}Map`),
        sampler: g.sampler(`${name}Sampler`),
        uv,
      });
    const heightMap = {
      texture: g.texture('heightMap'),
      sampler: g.sampler('heightSampler'),
    };
    const tiled = g.call(std.mul, {
      a: g.attribute('uv', BuiltinTypes.vec2f),
      b: 2,
    });
    // Per fragment: read per pixel, not interpolated from the vertices.
    let uv = g.call(std.perFragment, { value: tiled });
    let normal: PortHandle | undefined;
    let positionOffset: PortHandle | undefined;
    switch (technique) {
      case 'normal':
        // The normal map, in the frame of the tangents of the mesh.
        normal = g.call(stdMacros.normalMapping, {
          sample: read('normal', uv).swizzle('rgb'),
          uv,
        });
        break;
      case 'bump':
        // The slopes of the height on the screen tilt the normal.
        normal = g.call(stdMacros.bumpMapping, {
          height: read('height', uv).swizzle('x'),
          scale: 0.04,
        });
        break;
      case 'parallax':
        // The uv where the view meets the relief; the color and the normal
        // map are read there.
        uv = g.call(
          stdMacros.parallaxOcclusionMapping,
          { ...heightMap, uv, scale: 0.06 },
          { params: { steps: 16 } }
        );
        normal = g.call(stdMacros.normalMapping, {
          sample: read('normal', uv).swizzle('rgb'),
          uv,
        });
        break;
      case 'displacement':
        // The vertices moved along their normal (in the vertex stage), the
        // normal bumped by the same height (per pixel).
        positionOffset = g.call(stdMacros.displacement, {
          ...heightMap,
          uv: tiled,
          scale: 0.025,
        });
        normal = g.call(stdMacros.bumpMapping, {
          height: read('height', uv).swizzle('x'),
          scale: 0.025 * 1.8,
        });
        break;
    }
    g.surface({
      shadingModel: 'phong',
      baseColor: read('color', uv).swizzle('rgb'),
      specular: [0.15, 0.15, 0.15],
      shininess: 24,
      ...(normal ? { normal } : {}),
      ...(positionOffset ? { positionOffset } : {}),
    });
    return new Material({ graph: g.build(), values });
  };

  // --- The scene: four walls lying on the ground, seen at an angle.
  // Enough vertices to displace (180 × 180 cells); the tangents for the
  // normal mapping of the first two.
  const plane = createPlane(180);
  const withTangents = computeTangents(plane);
  const techniques = ['normal', 'bump', 'parallax', 'displacement'] as const;
  const detailed = techniques.map(material);
  const flat = material('flat');
  const items = techniques.map((technique, i) => ({
    mesh: technique === 'displacement' ? plane : withTangents,
    material: detailed[i],
    transform: new Transform({
      position: { x: (i % 2) * 2 - 1, y: 0, z: Math.floor(i / 2) * 2 - 1 },
      scale: { x: 1.8, y: 1.8, z: 1.8 },
    }),
  }));

  const camera = new Camera({
    position: { x: 0, y: 2, z: 3.6 },
    rotation: axisAngle(1, 0, 0, -0.5),
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 50,
    },
  });
  const sun = new DirectionalLight({
    direction: { x: -0.4, y: -1, z: -0.3 },
    ambient: { x: 0.15, y: 0.15, z: 0.15 },
    diffuse: { x: 0.3, y: 0.3, z: 0.3 },
    specular: { x: 0.3, y: 0.3, z: 0.3 },
  });
  // A lamp turning low over the walls: the relief catches its light.
  const lamp = new PointLight({
    ambient: { x: 0, y: 0, z: 0 },
    diffuse: { x: 1, y: 0.9, z: 0.75 },
    specular: { x: 1, y: 0.9, z: 0.75 },
    linearAttenuation: 0.3,
    quadraticAttenuation: 0.2,
  });
  const renderer = new Renderer(backend);

  let details = true;
  const show = () =>
    info(
      details
        ? 'normal, bump, parallax occlusion, displacement (click: flat)'
        : 'flat (click: with details)'
    );
  show();
  canvas.addEventListener('click', () => {
    details = !details;
    items.forEach((item, i) => {
      item.material = details ? detailed[i] : flat;
    });
    show();
  });

  onFrame((time) => {
    lamp.position = {
      x: 2.2 * Math.cos(time * 0.6),
      y: 0.6,
      z: 2.2 * Math.sin(time * 0.6),
    };
    renderer.render({
      items,
      camera,
      surface,
      lights: [sun, lamp],
      clearColor: { r: 0.1, g: 0.1, b: 0.12, a: 1 },
    });
  });
};

export default example;
