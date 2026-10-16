import {
  BuiltinTypes,
  GraphBuilder,
  std,
  stdMacros,
  type MaterialGraphData,
  type PortHandle,
} from '@fdw/engine-shader';
import type { MaterialData, TextureRef, UvTransform } from './data';

// The graphs of the material data, one per set of features: which textures
// are present, their uv sets and transforms, the vertex colors. The factors
// are uniforms, so every material of a set shares one program and one
// pipeline ("changing a value never recompiles the shader").

/** The texture slots of the graphs: `${slot}Texture` and `${slot}Sampler`. */
export type TextureSlot =
  | 'baseColor'
  | 'metallicRoughness'
  | 'normal'
  | 'occlusion'
  | 'emissive'
  | 'diffuse'
  | 'specular'
  | 'shininess';

/** The textures of a material data, by slot. */
export function texturesOf(
  data: MaterialData,
): Partial<Record<TextureSlot, TextureRef>> {
  const slots: Partial<Record<TextureSlot, TextureRef | undefined>> =
    data.kind === 'pbr'
      ? {
          baseColor: data.baseColorTexture,
          metallicRoughness: data.metallicRoughnessTexture,
          normal: data.normalTexture,
          occlusion: data.occlusionTexture,
          emissive: data.emissiveTexture,
        }
      : {
          diffuse: data.diffuseTexture,
          specular: data.specularTexture,
          shininess: data.shininessTexture,
          normal: data.normalTexture,
          emissive: data.emissiveTexture,
        };
  return Object.fromEntries(
    Object.entries(slots).filter(([, ref]) => ref !== undefined),
  );
}

/** The slots read as colors (sRGB); the others hold data. */
export const colorSlots: ReadonlySet<TextureSlot> = new Set([
  'baseColor',
  'emissive',
  'diffuse',
  'specular',
]);

/** What selects a graph: two materials with the same key share it. */
export function featureKey(data: MaterialData): string {
  const textures = Object.entries(texturesOf(data))
    .map(([slot, ref]) => `${slot}:${ref.texCoord}${ref.transform ? 't' : ''}`)
    .sort()
    .join(',');
  const flags =
    data.kind === 'pbr'
      ? `${data.unlit ? 'u' : ''}${data.vertexColors ? 'c' : ''}`
      : '';
  return `${data.kind}|${flags}|${textures}`;
}

const graphs = new Map<string, MaterialGraphData>();

/** The graph of a material data, built once per set of features. */
export function materialGraph(data: MaterialData): MaterialGraphData {
  const key = featureKey(data);
  let graph = graphs.get(key);
  if (!graph) {
    graph = data.kind === 'pbr' ? pbrGraph(data, key) : phongGraph(data, key);
    graphs.set(key, graph);
  }
  return graph;
}

/** The two rows of the matrix of `KHR_texture_transform`: translation × rotation × scale. */
export function uvTransformRows({
  offset,
  rotation,
  scale,
}: UvTransform): [number[], number[]] {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return [
    [c * scale[0], -s * scale[1], offset[0]],
    [s * scale[0], c * scale[1], offset[1]],
  ];
}

function sampler(
  g: GraphBuilder,
  textures: Partial<Record<TextureSlot, TextureRef>>,
) {
  const uvs = new Map<number, PortHandle>();
  const uvOf = (set: number) => {
    let uv = uvs.get(set);
    if (!uv)
      uvs.set(
        set,
        (uv = g.attribute(set === 0 ? 'uv' : `uv${set}`, BuiltinTypes.vec2f)),
      );
    return uv;
  };
  const uvFor = (slot: TextureSlot) => {
    const ref = textures[slot]!;
    const uv = uvOf(ref.texCoord);
    if (!ref.transform) return uv;
    const h = g.call(std.vec3, {
      x: uv.swizzle('x'),
      y: uv.swizzle('y'),
      z: 1,
    });
    return g.call(std.vec2, {
      x: g.call(std.dot, {
        a: g.uniform(`${slot}UvRow0`, BuiltinTypes.vec3f, {
          default: [1, 0, 0],
        }),
        b: h,
      }),
      y: g.call(std.dot, {
        a: g.uniform(`${slot}UvRow1`, BuiltinTypes.vec3f, {
          default: [0, 1, 0],
        }),
        b: h,
      }),
    });
  };
  const sample = (slot: TextureSlot) =>
    g.call(std.textureSample, {
      texture: g.texture(`${slot}Texture`),
      sampler: g.sampler(`${slot}Sampler`),
      uv: uvFor(slot),
    });
  return { sample, uvFor };
}

function pbrGraph(
  data: MaterialData & { kind: 'pbr' },
  key: string,
): MaterialGraphData {
  const g = new GraphBuilder(key);
  const textures = texturesOf(data);
  const { sample, uvFor } = sampler(g, textures);
  const { vec3f, vec4f, f32 } = BuiltinTypes;

  let baseColor = g.uniform('baseColorFactor', vec4f, {
    default: [1, 1, 1, 1],
  });
  if (textures.baseColor)
    baseColor = g.call(std.mul, { a: baseColor, b: sample('baseColor') });
  if (data.vertexColors) {
    baseColor = g.call(std.mul, {
      a: baseColor,
      b: g.call(
        stdMacros.optionalAttribute,
        { fallback: [1, 1, 1, 1] },
        { params: { semantic: 'color', type: vec4f } },
      ),
    });
  }
  const color = baseColor.swizzle('rgb');
  const alpha = baseColor.swizzle('a');
  if (data.unlit) {
    g.surface({ shadingModel: 'unlit', baseColor: color, alpha });
    return g.build();
  }

  let metallic = g.uniform('metallicFactor', f32, { default: 1 });
  let roughness = g.uniform('roughnessFactor', f32, { default: 1 });
  if (textures.metallicRoughness) {
    const texel = sample('metallicRoughness');
    roughness = g.call(std.mul, { a: roughness, b: texel.swizzle('g') });
    metallic = g.call(std.mul, { a: metallic, b: texel.swizzle('b') });
  }
  let emissive = g.uniform('emissiveFactor', vec3f, { default: [0, 0, 0] });
  if (textures.emissive)
    emissive = g.call(std.mul, {
      a: emissive,
      b: sample('emissive').swizzle('rgb'),
    });

  const extra: Record<string, PortHandle> = {};
  if (textures.normal) {
    extra['normal'] = g.call(stdMacros.normalMapping, {
      sample: sample('normal').swizzle('rgb'),
      strength: g.uniform('normalScale', f32, { default: 1 }),
      uv: uvFor('normal'),
    });
  }
  if (textures.occlusion) {
    extra['occlusion'] = g.call(std.mix, {
      a: 1,
      b: sample('occlusion').swizzle('r'),
      t: g.uniform('occlusionStrength', f32, { default: 1 }),
    });
  }
  g.surface({
    shadingModel: 'pbr',
    baseColor: color,
    alpha,
    metallic,
    roughness,
    emissive,
    ...extra,
  });
  return g.build();
}

function phongGraph(
  data: MaterialData & { kind: 'phong' },
  key: string,
): MaterialGraphData {
  const g = new GraphBuilder(key);
  const textures = texturesOf(data);
  const { sample, uvFor } = sampler(g, textures);
  const { vec3f, f32 } = BuiltinTypes;

  let diffuse = g.uniform('diffuseFactor', vec3f, { default: [1, 1, 1] });
  let alpha = g.uniform('opacity', f32, { default: 1 });
  if (textures.diffuse) {
    const texel = sample('diffuse');
    diffuse = g.call(std.mul, { a: diffuse, b: texel.swizzle('rgb') });
    alpha = g.call(std.mul, { a: alpha, b: texel.swizzle('a') });
  }
  let specular = g.uniform('specularFactor', vec3f, { default: [0, 0, 0] });
  if (textures.specular)
    specular = g.call(std.mul, {
      a: specular,
      b: sample('specular').swizzle('rgb'),
    });
  let shininess = g.uniform('shininessFactor', f32, { default: 32 });
  if (textures.shininess)
    shininess = g.call(std.mul, {
      a: shininess,
      b: sample('shininess').swizzle('r'),
    });
  let emissive = g.uniform('emissiveFactor', vec3f, { default: [0, 0, 0] });
  if (textures.emissive)
    emissive = g.call(std.mul, {
      a: emissive,
      b: sample('emissive').swizzle('rgb'),
    });

  const extra: Record<string, PortHandle> = {};
  if (textures.normal) {
    extra['normal'] = g.call(stdMacros.normalMapping, {
      sample: sample('normal').swizzle('rgb'),
      uv: uvFor('normal'),
    });
  }
  g.surface({
    shadingModel: 'phong',
    baseColor: diffuse,
    alpha,
    specular,
    shininess,
    emissive,
    ...extra,
  });
  return g.build();
}
