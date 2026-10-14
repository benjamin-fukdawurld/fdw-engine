import { BuiltinTypes } from '../types/ShaderType';
import { NodeDefinition, resolveParams } from '../graph/NodeDefinition';
import { arrayElementOf, generic } from '../types/PortType';

/**
 * The shading models of the standard library. Others can be registered with
 * {@link defineShadingModel}.
 *
 * @group Standard library
 */
export const ShadingModelNames = ['unlit', 'phong', 'pbr'] as const;
/**
 * A shading model: `unlit`, `phong`, `pbr`, or the name of a shading model
 * registered as the node type `lighting.<name>`.
 *
 * @group Standard library
 */
export type ShadingModel = (typeof ShadingModelNames)[number] | (string & {});

/**
 * The surface of the material. Its inputs are those of its shading model
 * (the node type `lighting.<shadingModel>`), plus `positionOffset`: the
 * compiler inserts the model, which turns the surface into the final color.
 */
export const surface: NodeDefinition = {
  id: 'output.surface',
  category: 'output',
  params: {
    shadingModel: { kind: 'string', default: 'unlit' },
  },
  inputs: (params, context) => {
    const name = params['shadingModel'] as string;
    const model = context?.registry?.get(`lighting.${name}`);
    if (!model) {
      throw new Error(
        `unknown shading model "${name}" (no lighting.${name} node type)`
      );
    }
    const ports = model
      .inputs(resolveParams(model, {}), context)
      .filter((port) => port.name !== 'worldPosition')
      // The interpolated normal of the mesh when unconnected.
      .map((port) =>
        port.name === 'normal' ? { ...port, optional: true } : port
      );
    return [
      // Vertex stage: displacement of the vertex, in object space.
      { name: 'positionOffset', type: BuiltinTypes.vec3f, default: [0, 0, 0] },
      ...ports,
    ];
  },
  outputs: () => [],
};

/**
 * The output of a compute graph: the size of its workgroups. What the graph
 * computes is written by its write.storage nodes.
 */
export const compute: NodeDefinition = {
  id: 'output.compute',
  category: 'output',
  params: {
    workgroupSize: { kind: 'constant', default: [64, 1, 1] },
  },
  inputs: () => [],
  outputs: () => [],
  stage: () => 'compute',
};

/**
 * Writes an element of a storage buffer, in a compute graph:
 * array[index] = value, when `when` is true (or unconnected). The array is
 * a storage buffer with read-write access. Writes are made after every
 * computation of the thread, in the order of the graph.
 */
export const writeStorage: NodeDefinition = {
  id: 'write.storage',
  category: 'output',
  inputs: () => [
    { name: 'array', type: generic('A', 'array') },
    { name: 'index', type: generic('I', 'integer') },
    { name: 'value', type: arrayElementOf('A') },
    { name: 'when', type: BuiltinTypes.bool, optional: true },
  ],
  outputs: () => [],
  stage: () => 'compute',
};

/**
 * A vertex attribute computed by the graph instead of read from the mesh:
 * every input.attribute of this semantic, in the graph and in what the
 * compiler adds (the vertex stage of output.surface, the macros), reads
 * `value` instead. Vertex stage. The geometry generated in the vertex
 * shader (the patches of the tessellation) gives its position, normal and
 * uv this way; the mesh then needs no such attribute.
 */
export const attribute: NodeDefinition = {
  id: 'output.attribute',
  category: 'output',
  params: {
    semantic: { kind: 'string', required: true },
  },
  inputs: () => [{ name: 'value', type: generic('T', 'numeric') }],
  outputs: () => [],
  stage: () => 'vertex',
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

/**
 * A full screen pass (a post-processing effect): the color of each pixel of
 * the target. The compiler generates the vertex stage, a triangle covering
 * the target without mesh; the 'screen-uv' builtin gives the coordinates of
 * the pixel in the target.
 */
export const fullscreen: NodeDefinition = {
  id: 'output.fullscreen',
  category: 'output',
  inputs: () => [{ name: 'color', type: BuiltinTypes.vec4f }],
  outputs: () => [],
};

/**
 * A value of the material for a scene output declared 'material': written
 * to the target of that name by the passes that have it (see the outputs of
 * Renderer.addScenePasses), ignored by the others. With output.surface.
 */
export const value: NodeDefinition = {
  id: 'output.value',
  category: 'output',
  params: { name: { kind: 'string', required: true } },
  inputs: () => [{ name: 'value', type: generic('T', 'numeric') }],
  outputs: () => [],
};

/**
 * A color target written besides the color of output.fragment (multiple
 * render targets): its value goes to the attachment `location` of the pass.
 * Scalars and vectors of f32, u32 or i32; the format of the attachment must
 * match (float or normalized for f32, uint for u32, sint for i32). Location
 * 0 is the color of output.fragment when it has one.
 */
export const target: NodeDefinition = {
  id: 'output.target',
  category: 'output',
  params: {
    name: { kind: 'string', required: true },
    location: { kind: 'number', required: true },
  },
  inputs: () => [{ name: 'value', type: generic('T', 'numeric') }],
  outputs: () => [],
  stage: () => 'fragment',
};

export const fragment: NodeDefinition = {
  id: 'output.fragment',
  category: 'output',
  inputs: () => [
    // Without color, the fragment only writes its depth: depth-only passes
    // (shadow maps, depth prepasses), drawn without color target.
    { name: 'color', type: BuiltinTypes.vec4f, optional: true },
    // Abandons the fragment when true: neither color nor depth is written.
    { name: 'discard', type: BuiltinTypes.bool, optional: true },
  ],
  outputs: () => [],
  stage: () => 'fragment',
};
