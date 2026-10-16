import type { PhongMaterialData, TextureRef } from '@fdw/engine-assets';
import type { GpuSamplerConfiguration } from '@fdw/engine-backend';
import { defineResourceType, type ResourceLoader } from '@fdw/engine-resources';

/** The materials of a MTL file, by name. */
export type MtlLibrary = ReadonlyMap<string, PhongMaterialData>;

export const MtlType = defineResourceType<MtlLibrary>('mtl');

const repeat: GpuSamplerConfiguration = {
  wrapModeS: 'repeat',
  wrapModeT: 'repeat',
  minFilter: 'linear',
  magFilter: 'linear',
  mipmapFilter: 'linear',
};

/**
 * A texture statement: `map_Kd -s 2 2 1 -o 0.5 0 0 -clamp on textures/a.png`.
 * The options of scale, offset and clamping are kept; the others are
 * skipped. `resolve` makes the path a URI, relative to the MTL file.
 */
export function parseMtlTexture(
  value: string,
  resolve: (path: string) => string,
): TextureRef {
  const parts = value.trim().split(/\s+/);
  // The number of values of each option.
  const arity: Record<string, number> = {
    '-s': 3,
    '-o': 3,
    '-t': 3,
    '-mm': 2,
    '-bm': 1,
    '-boost': 1,
    '-texres': 1,
    '-imfchan': 1,
    '-clamp': 1,
    '-blendu': 1,
    '-blendv': 1,
    '-cc': 1,
    '-type': 1,
  };
  let scale: [number, number] = [1, 1];
  let offset: [number, number] = [0, 0];
  let clamp = false;
  let i = 0;
  while (
    i < parts.length &&
    parts[i].startsWith('-') &&
    arity[parts[i]] !== undefined
  ) {
    const option = parts[i];
    const values = parts.slice(i + 1, i + 1 + arity[option]);
    if (option === '-s')
      scale = [Number(values[0]), Number(values[1] ?? values[0])];
    if (option === '-o') offset = [Number(values[0]), Number(values[1] ?? 0)];
    if (option === '-clamp') clamp = values[0] === 'on';
    i += 1 + arity[option];
  }
  const transformed =
    scale[0] !== 1 || scale[1] !== 1 || offset[0] !== 0 || offset[1] !== 0;
  return {
    // A file name may hold spaces.
    image: resolve(parts.slice(i).join(' ').replace(/\\/g, '/')),
    texCoord: 0,
    sampler: clamp
      ? { ...repeat, wrapModeS: 'clamp-to-edge', wrapModeT: 'clamp-to-edge' }
      : repeat,
    ...(transformed ? { transform: { offset, rotation: 0, scale } } : {}),
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const newMaterial = (name: string): Mutable<PhongMaterialData> => ({
  kind: 'phong',
  name,
  diffuse: [0.8, 0.8, 0.8],
  specular: [0, 0, 0],
  shininess: 32,
  emissive: [0, 0, 0],
  opacity: 1,
  alphaMode: 'opaque',
  doubleSided: false,
});

/**
 * Parses a MTL file into Phong materials. `bump` is ignored (a height map,
 * where the engine wants a normal map: `norm`); the ambient color too (the
 * lights have theirs).
 */
export function parseMtl(
  text: string,
  resolve: (path: string) => string = (path) => path,
  warn: (message: string) => void = () => undefined,
): Map<string, PhongMaterialData> {
  const materials = new Map<string, PhongMaterialData>();
  let current: Mutable<PhongMaterialData> | undefined;
  const color = (value: string) => {
    const [r, g = r, b = r] = value.trim().split(/\s+/).map(Number);
    return [r, g, b] as const;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const space = line.search(/\s/);
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1).trim();
    if (key === 'newmtl') {
      current = newMaterial(value);
      materials.set(value, current);
      continue;
    }
    if (!current) continue;
    switch (key) {
      case 'Kd':
        current.diffuse = color(value);
        break;
      case 'Ks':
        current.specular = color(value);
        break;
      case 'Ke':
        current.emissive = color(value);
        break;
      case 'Ns':
        current.shininess = Number(value);
        break;
      case 'd':
        current.opacity = Number(value);
        break;
      case 'Tr':
        current.opacity = 1 - Number(value);
        break;
      case 'map_Kd':
        current.diffuseTexture = parseMtlTexture(value, resolve);
        break;
      case 'map_Ks':
        current.specularTexture = parseMtlTexture(value, resolve);
        break;
      case 'map_Ns':
        current.shininessTexture = parseMtlTexture(value, resolve);
        break;
      case 'map_Ke':
        current.emissiveTexture = parseMtlTexture(value, resolve);
        break;
      case 'norm':
        current.normalTexture = parseMtlTexture(value, resolve);
        break;
      case 'Ka':
      case 'map_Ka':
      case 'Ni':
      case 'illum':
      case 'Tf':
        break;
      default:
        warn(`MTL: ${key} is not supported`);
    }
  }
  for (const material of materials.values()) {
    const m = material as Mutable<PhongMaterialData>;
    if (m.opacity < 1) m.alphaMode = 'blend';
  }
  return materials;
}

/** MTL files, as dependencies of the OBJ files that name them (`mtllib`). */
export const mtlLoader: ResourceLoader<MtlLibrary> = {
  type: MtlType,
  extensions: ['mtl'],
  async load(ctx) {
    return parseMtl(await ctx.text(), (path) => ctx.resolve(path));
  },
};
