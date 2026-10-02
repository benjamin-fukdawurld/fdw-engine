import { T } from '../types/ShaderType';
import type { NodeDefinition, PortSchema } from '../graph/NodeDefinition';

export const ShadingModelNames = ['unlit', 'phong', 'pbr'] as const;
export type ShadingModel = (typeof ShadingModelNames)[number];

const commonPorts: readonly PortSchema[] = [
  { name: 'baseColor', type: T.vec3f, default: [1, 1, 1] },
  { name: 'alpha', type: T.f32, default: 1 },
  // Vertex stage: displacement of the vertex, in object space.
  { name: 'positionOffset', type: T.vec3f, default: [0, 0, 0] },
];

const litPorts: readonly PortSchema[] = [
  { name: 'emissive', type: T.vec3f, default: [0, 0, 0] },
  // World-space normal. When unconnected, the compiler uses the interpolated
  // vertex normal.
  { name: 'normal', type: T.vec3f, optional: true },
];

const shadingModelPorts: Record<ShadingModel, readonly PortSchema[]> = {
  unlit: [],
  phong: [
    { name: 'specular', type: T.vec3f, default: [1, 1, 1] },
    { name: 'shininess', type: T.f32, default: 32 },
  ],
  pbr: [
    { name: 'roughness', type: T.f32, default: 0.5 },
    { name: 'metallic', type: T.f32, default: 0 },
  ],
};

// The surface of the material. A shading model, inserted by the compiler,
// turns it into the final color.
export const surface: NodeDefinition = {
  id: 'output.surface',
  category: 'output',
  params: {
    shadingModel: {
      kind: 'string',
      values: ShadingModelNames,
      default: 'unlit',
    },
  },
  inputs: (params) => {
    const model = params['shadingModel'] as ShadingModel;
    return model === 'unlit'
      ? commonPorts
      : [...commonPorts, ...litPorts, ...shadingModelPorts[model]];
  },
  outputs: () => [],
};

// Raw stage outputs, for full control (post-processing, full-screen passes).
// The compiler also lowers 'output.surface' to this pair.
export const vertex: NodeDefinition = {
  id: 'output.vertex',
  category: 'output',
  inputs: () => [{ name: 'clipPosition', type: T.vec4f }],
  outputs: () => [],
  stage: () => 'vertex',
};

export const fragment: NodeDefinition = {
  id: 'output.fragment',
  category: 'output',
  inputs: () => [{ name: 'color', type: T.vec4f }],
  outputs: () => [],
  stage: () => 'fragment',
};
