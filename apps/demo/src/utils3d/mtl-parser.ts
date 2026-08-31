import { uniformPrimitives } from '@fdw/engine-webgpu';
import { Material } from './Material';
import { readLines } from './utils';

export interface MtlTexture {
  url: string;
  blendU?: boolean;
  blendV?: boolean;
  cc?: boolean;
  clamp?: boolean;
  imfchan?: 'r' | 'g' | 'b' | 'l';
  bm?: number;
  mm?: [number, number];
  offset?: [number, number, number];
  scale?: [number, number, number];
}

export interface MtlMaterial {
  name: string;
  Ka?: [number, number, number]; // Ambient color
  map_Ka?: MtlTexture; // Ambient texture map
  Kd?: [number, number, number]; // Diffuse color
  map_Kd?: MtlTexture; // Diffuse texture map
  Ks?: [number, number, number]; // Specular color
  map_Ks?: MtlTexture; // Specular texture map
  Ke?: [number, number, number]; // Emissive color
  map_Ke?: MtlTexture; // Emissive texture map
  Ns?: number; // Specular exponent
  Ni?: number; // Optical density
  map_Ns?: MtlTexture; // Specular exponent texture map
  d?: number; // Dissolve (transparency)
  map_d?: MtlTexture; // Dissolve texture map
  disp?: MtlTexture; // Displacement map
  decal?: MtlTexture; // Decal map
  bump?: MtlTexture; // Bump map

  illum?: number; // Illumination model
}

export function parseTexture(value: string): MtlTexture {
  const parts = value.trim().split(/\s+/);
  const options: Omit<MtlTexture, 'url'> = {};
  let url = '';
  let i = 0;

  for (; i < parts.length; i++) {
    const part = parts[i];
    switch (part) {
      case '-s':
        options['scale'] = [
          parseFloat(parts[i + 1]),
          parseFloat(parts[i + 2]),
          parseFloat(parts[i + 3]),
        ];
        i += 3;
        break;
      case '-o':
        options['offset'] = [
          parseFloat(parts[i + 1]),
          parseFloat(parts[i + 2]),
          parseFloat(parts[i + 3]),
        ];
        i += 3;
        break;
      case '-mm':
        options['mm'] = [parseFloat(parts[i + 1]), parseFloat(parts[i + 2])];
        i += 2;
        break;
      case '-bm':
        options['bm'] = parseFloat(parts[i + 1]);
        i += 1;
        break;
      case '-imfchan':
        options['imfchan'] = parts[i + 1] as 'r' | 'g' | 'b' | 'l';
        i += 1;
        break;
      case '-clamp':
        options['clamp'] = parts[i + 1] === 'on';
        i += 1;
        break;
      case '-blendu':
        options['blendU'] = parts[i + 1] === 'on';
        i += 1;
        break;
      case '-blendv':
        options['blendV'] = parts[i + 1] === 'on';
        i += 1;
        break;
      default:
        break;
    }

    url = parts.slice(i).join(' ');
  }

  return { url, ...options };
}

export const mtlLineParser = {
  Ka: (value: string) =>
    value.trim().split(/\s+/).map(parseFloat) as [number, number, number],
  map_Ka: (value: string) => parseTexture(value),
  Kd: (value: string) =>
    value.trim().split(/\s+/).map(parseFloat) as [number, number, number],
  map_Kd: (value: string) => parseTexture(value),
  Ks: (value: string) =>
    value.trim().split(/\s+/).map(parseFloat) as [number, number, number],
  map_Ks: (value: string) => parseTexture(value),
  Ke: (value: string) =>
    value.trim().split(/\s+/).map(parseFloat) as [number, number, number],
  map_Ke: (value: string) => parseTexture(value),
  Ns: (value: string) => parseFloat(value),
  Ni: (value: string) => parseFloat(value),
  map_Ns: (value: string) => parseTexture(value),
  d: (value: string) => parseFloat(value),
  map_d: (value: string) => parseTexture(value),
  disp: (value: string) => parseTexture(value),
  decal: (value: string) => parseTexture(value),
  bump: (value: string) => parseTexture(value),
  illum: (value: string) => parseInt(value, 10),
};

export async function parseMtl(url: string): Promise<MtlMaterial[]> {
  const response = await fetch(url);
  let currentMaterial: MtlMaterial | null = null;
  const materials: MtlMaterial[] = [];

  for await (const line of readLines(response)) {
    const trimmedLine = line.trim();
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue; // Skip empty lines and comments
    }

    const spaceIndex = trimmedLine.indexOf(' ');
    const key =
      spaceIndex !== -1 ? trimmedLine.slice(0, spaceIndex) : trimmedLine;
    const value =
      spaceIndex !== -1 ? trimmedLine.slice(spaceIndex + 1).trim() : '';
    switch (key) {
      case 'newmtl':
        if (currentMaterial) {
          materials.push(currentMaterial);
        }
        currentMaterial = { name: value };
        break;
      case 'Ka':
        currentMaterial!.Ka = mtlLineParser.Ka(value);
        break;
      case 'map_Ka':
        currentMaterial!.map_Ka = mtlLineParser.map_Ka(value);
        break;
      case 'Kd':
        currentMaterial!.Kd = mtlLineParser.Kd(value);
        break;
      case 'map_Kd':
        currentMaterial!.map_Kd = mtlLineParser.map_Kd(value);
        break;
      case 'Ks':
        currentMaterial!.Ks = mtlLineParser.Ks(value);
        break;
      case 'map_Ks':
        currentMaterial!.map_Ks = mtlLineParser.map_Ks(value);
        break;
      case 'Ke':
        currentMaterial!.Ke = mtlLineParser.Ke(value);
        break;
      case 'map_Ke':
        currentMaterial!.map_Ke = mtlLineParser.map_Ke(value);
        break;
      case 'Ns':
        currentMaterial!.Ns = mtlLineParser.Ns(value);
        break;
      case 'Ni':
        currentMaterial!.Ni = mtlLineParser.Ni(value);
        break;
      case 'map_Ns':
        currentMaterial!.map_Ns = mtlLineParser.map_Ns(value);
        break;
      case 'd':
        currentMaterial!.d = mtlLineParser.d(value);
        break;
      case 'map_d':
        currentMaterial!.map_d = mtlLineParser.map_d(value);
        break;
      case 'disp':
        currentMaterial!.disp = mtlLineParser.disp(value);
        break;
      case 'decal':
        currentMaterial!.decal = mtlLineParser.decal(value);
        break;
      case 'bump':
        currentMaterial!.bump = mtlLineParser.bump(value);
        break;
      case 'illum':
        currentMaterial!.illum = mtlLineParser.illum(value);
        break;
      default:
        console.warn(`Unknown MTL property: ${key}`);
    }
  }

  if (currentMaterial) {
    materials.push(currentMaterial);
  }

  return materials;
}

export function mtlMaterialToMaterial(mtlMaterial: MtlMaterial): Material {
  const material = new Material({ type: mtlMaterial.name });
  if (mtlMaterial.Ka) {
    material.materialUniforms.push({
      name: 'ambientColor',
      type: uniformPrimitives.vec3,
      value: new Float32Array(mtlMaterial.Ka),
      stages: ['fragment'],
    });
  }

  if (mtlMaterial.Kd) {
    material.materialUniforms.push({
      name: 'diffuseColor',
      type: uniformPrimitives.vec3,
      value: new Float32Array(mtlMaterial.Kd),
      stages: ['fragment'],
    });
  }

  if (mtlMaterial.Ks) {
    material.materialUniforms.push({
      name: 'specularColor',
      type: uniformPrimitives.vec3,
      value: new Float32Array(mtlMaterial.Ks),
      stages: ['fragment'],
    });
  }

  if (mtlMaterial.Ke) {
    material.materialUniforms.push({
      name: 'emissiveColor',
      type: uniformPrimitives.vec3,
      value: new Float32Array(mtlMaterial.Ke),
      stages: ['fragment'],
    });
  }

  if (mtlMaterial.Ns !== undefined) {
    material.materialUniforms.push({
      name: 'specularExponent',
      type: uniformPrimitives.float32,
      value: new Float32Array([mtlMaterial.Ns]),
      stages: ['fragment'],
    });
  }

  if (mtlMaterial.Ni !== undefined) {
    material.materialUniforms.push({
      name: 'opticalDensity',
      type: uniformPrimitives.float32,
      value: new Float32Array([mtlMaterial.Ni]),
      stages: ['fragment'],
    });
  }

  if (mtlMaterial.d !== undefined) {
    material.materialUniforms.push({
      name: 'dissolve',
      type: uniformPrimitives.float32,
      value: new Float32Array([mtlMaterial.d]),
      stages: ['fragment'],
    });
  }

  return material;
}
