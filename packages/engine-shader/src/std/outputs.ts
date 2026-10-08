import { BuiltinTypes } from '../types/ShaderType';
import type { NodeDefinition, PortSchema } from '../graph/NodeDefinition';

/**
 * The shading models of `output.surface`.
 *
 * @group Standard library
 */
export const ShadingModelNames = ['unlit', 'phong', 'pbr'] as const;
/**
 * A shading model: `unlit`, `phong` (`pbr` is declared but not implemented
 * yet). Each one is a macro named `lighting.<model>`.
 *
 * @group Standard library
 */
export type ShadingModel = (typeof ShadingModelNames)[number];

const commonPorts: readonly PortSchema[] = [
  { name: 'baseColor', type: BuiltinTypes.vec3f, default: [1, 1, 1] },
  // Opacity: blended with 'blend' materials, compared to the alphaCutoff
  // uniform with 'mask' ones.
  { name: 'alpha', type: BuiltinTypes.f32, default: 1 },
  // Vertex stage: displacement of the vertex, in object space.
  { name: 'positionOffset', type: BuiltinTypes.vec3f, default: [0, 0, 0] },
];

const litPorts: readonly PortSchema[] = [
  { name: 'emissive', type: BuiltinTypes.vec3f, default: [0, 0, 0] },
  // World-space normal. When unconnected, the compiler uses the interpolated
  // vertex normal.
  { name: 'normal', type: BuiltinTypes.vec3f, optional: true },
];

const shadingModelPorts: Record<ShadingModel, readonly PortSchema[]> = {
  unlit: [],
  phong: [
    { name: 'specular', type: BuiltinTypes.vec3f, default: [1, 1, 1] },
    { name: 'shininess', type: BuiltinTypes.f32, default: 32 },
  ],
  pbr: [
    { name: 'roughness', type: BuiltinTypes.f32, default: 0.5 },
    { name: 'metallic', type: BuiltinTypes.f32, default: 0 },
  ],
};

/**
 * The surface of the material. A shading model, inserted by the compiler,
 * turns it into the final color.
 */
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

/**
 * Raw stage outputs, for full control (post-processing, full-screen passes).
 * The compiler also lowers 'output.surface' to this pair.
 */
export const vertex: NodeDefinition = {
  id: 'output.vertex',
  category: 'output',
  inputs: () => [{ name: 'clipPosition', type: BuiltinTypes.vec4f }],
  outputs: () => [],
  stage: () => 'vertex',
};

export const fragment: NodeDefinition = {
  id: 'output.fragment',
  category: 'output',
  inputs: () => [
    { name: 'color', type: BuiltinTypes.vec4f },
    // Abandons the fragment when true: neither color nor depth is written.
    { name: 'discard', type: BuiltinTypes.bool, optional: true },
  ],
  outputs: () => [],
  stage: () => 'fragment',
};
