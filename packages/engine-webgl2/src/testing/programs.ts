import type {
  MeshDescription,
  RenderPipelineDescriptor,
} from '@fdw/engine-backend';
import { BuiltinTypes, CompiledProgram } from '@fdw/engine-shader';

// A program for the unit tests: a constant position and color, reading
// the position attribute (unused by its code: the fake context links
// anything), with a uniform block in the material slot if asked.
export function testProgram(
  programKey = 'test',
  { uniforms = false } = {},
): CompiledProgram {
  const clipPosition = {
    name: 'clipPosition',
    type: BuiltinTypes.vec4f,
    builtin: 'position' as const,
  };
  return {
    name: `program ${programKey}`,
    programKey,
    variantKey: {},
    layout: {
      groups: uniforms
        ? [
            {
              slot: 'material',
              bindings: [
                {
                  kind: 'uniform-block',
                  name: 'material',
                  members: [{ name: 'tint', type: BuiltinTypes.vec4f }],
                },
              ],
            },
          ]
        : [],
    },
    vertexInputs: [
      {
        semantic: 'position',
        type: BuiltinTypes.vec3f,
        location: 0,
        name: 'a_position',
      },
    ],
    diagnostics: [],
    module: {
      name: 'test',
      entryPoints: [
        {
          stage: 'vertex',
          inputs: [],
          outputs: [clipPosition],
          body: [
            {
              id: 1,
              type: BuiltinTypes.vec4f,
              op: { kind: 'constant', value: [0, 0, 0, 1] },
              args: [],
            },
          ],
          results: { clipPosition: 1 },
        },
        {
          stage: 'fragment',
          inputs: [clipPosition],
          outputs: [{ name: 'color', type: BuiltinTypes.vec4f, location: 0 }],
          body: [
            {
              id: 1,
              type: BuiltinTypes.vec4f,
              op: { kind: 'constant', value: [1, 0, 0, 1] },
              args: [],
            },
          ],
          results: { color: 1 },
        },
      ],
    },
  };
}

// Positions in a buffer, and the normals, unread, in another one.
export const testMesh: MeshDescription = {
  vertexBuffers: [
    {
      stride: 12,
      stepMode: 'vertex',
      attributes: [{ semantic: 'normal', format: 'float32x3', offset: 0 }],
    },
    {
      stride: 16,
      stepMode: 'vertex',
      attributes: [{ semantic: 'position', format: 'float32x3', offset: 4 }],
    },
  ],
  vertexCount: 3,
};

export const testPipeline = (
  program = testProgram(),
  overrides: Partial<RenderPipelineDescriptor> = {},
): RenderPipelineDescriptor => ({
  program,
  vertex: testMesh,
  primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
  depthStencil: {
    format: 'depth24plus',
    depthWrite: true,
    depthCompare: 'less',
  },
  targets: [{ format: 'rgba8unorm' }],
  ...overrides,
});
