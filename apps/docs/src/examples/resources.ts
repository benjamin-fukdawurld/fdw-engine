import {
  Camera,
  DirectionalLight,
  Renderer,
  Transform,
  type Material,
} from '@fdw/engine-core';
import {
  defaultPbrMaterial,
  installAssets,
  MaterialDataType,
  MaterialType,
  TextureType,
  textureOptions,
  type ImageCodec,
  type PbrMaterialData,
} from '@fdw/engine-assets';
import {
  defineResourceType,
  MemorySource,
  ResourceError,
  ResourceStore,
} from '@fdw/engine-resources';
import { axisAngle, createCube } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A store of resources in memory: an image format of our own (a codec), a
// resource type of our own (a palette), a material realized from its data,
// and the hot reload of its texture every two seconds.
const example: Example = async ({ backend, surface, onFrame, info }) => {
  // --- A codec: "P3" PPM images, the simplest of the text formats.
  const ppmCodec: ImageCodec = {
    name: 'ppm',
    extensions: ['ppm'],
    sniff: (head) => head[0] === 0x50 && head[1] === 0x33, // "P3"
    async decode(bytes, { uri } = {}) {
      const words = new TextDecoder()
        .decode(bytes)
        .replace(/#.*$/gm, '')
        .split(/\s+/)
        .filter(Boolean);
      const [width, height, max] = words.slice(1, 4).map(Number);
      if (!(width > 0 && height > 0 && max > 0)) {
        throw new ResourceError('decode', uri ?? 'ppm', 'Bad PPM header');
      }
      const pixels = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        for (let c = 0; c < 3; c++) {
          pixels[i * 4 + c] = (Number(words[4 + i * 3 + c]) * 255) / max;
        }
        pixels[i * 4 + 3] = 255;
      }
      return {
        type: '2d',
        width,
        height,
        format: 'rgba8unorm',
        levels: [pixels],
      };
    },
  };

  // --- A resource type: the colors of the checker, from a JSON file.
  interface Palette {
    readonly light: number[];
    readonly dark: number[];
  }
  const PaletteType = defineResourceType<Palette>('palette');

  const files = new MemorySource({
    'palettes/warm.json': JSON.stringify({
      light: [250, 220, 160],
      dark: [180, 60, 40],
    }),
    'palettes/cold.json': JSON.stringify({
      light: [200, 230, 255],
      dark: [30, 70, 160],
    }),
  });
  const resources = new ResourceStore();
  resources.mount('mem', files, { default: true });
  installAssets(resources, { backend, codecs: [ppmCodec] });
  resources.registerLoader({
    type: PaletteType,
    async load(context) {
      return JSON.parse(await context.text()) as Palette;
    },
  });

  // A 4 × 4 checker in the colors of a palette, written as a PPM file.
  const checker = ({ light, dark }: Palette) => {
    const rows: string[] = ['P3 4 4 255'];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        rows.push(((x + y) % 2 === 0 ? light : dark).join(' '));
      }
    }
    return rows.join('\n');
  };
  const palettes = await Promise.all(
    ['warm', 'cold'].map(
      (name) => resources.load(PaletteType, `palettes/${name}.json`).ready
    )
  );
  files.set('checker.ppm', checker(palettes[0]));

  // --- A material from its data: the data is defined in memory, the
  // material realized from it, its texture loaded as a dependency.
  const data: PbrMaterialData = {
    ...defaultPbrMaterial,
    roughness: 0.6,
    baseColorTexture: {
      image: 'checker.ppm',
      texCoord: 0,
      sampler: {
        wrapModeS: 'repeat',
        wrapModeT: 'repeat',
        minFilter: 'nearest',
        magFilter: 'nearest',
        mipmapFilter: 'nearest',
      },
    },
  };
  resources.define(MaterialDataType, 'box#material', data);
  const material = await resources.load<Material>(MaterialType, 'box#material')
    .ready;
  // The same texture: same URI, same options (sRGB, the sampler of the data).
  const texture = resources.load(TextureType, 'checker.ppm', {
    options: textureOptions('baseColor', data.baseColorTexture!),
  });

  // --- The hot reload: the store watches its sources; rewriting the file
  // reloads the texture, and the material takes it in place.
  resources.watch(true);
  let shown = 0;

  const cube = createCube();
  const transform = new Transform();
  const camera = new Camera({
    position: { x: 0, y: 0.8, z: 3 },
    rotation: axisAngle(1, 0, 0, -0.25),
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 50,
    },
  });
  const sun = new DirectionalLight({ direction: { x: -1, y: -1, z: -1 } });
  const renderer = new Renderer(backend);

  onFrame((time) => {
    // Every two seconds, the other palette.
    const palette = Math.floor(time / 2) % 2;
    if (palette !== shown) {
      shown = palette;
      files.set('checker.ppm', checker(palettes[palette]));
    }
    // Between two frames: the reloaded resources are swapped here.
    resources.update();
    info(`texture version ${texture.version.value}`);
    transform.rotation = axisAngle(0, 1, 0, time * 0.6);
    renderer.render({
      items: [{ mesh: cube, material, transform }],
      camera,
      surface,
      lights: [sun],
      clearColor: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
    });
  });
};

export default example;
