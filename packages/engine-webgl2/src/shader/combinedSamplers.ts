import type { PhysicalProgramLayout } from '@fdw/engine-backend';
import {
  forEachInstruction,
  IrInstruction,
  ShaderModuleIR,
  TextureType,
} from '@fdw/engine-shader';

// GLSL ES has no separate samplers: a texture is sampled through a sampler2D
// that combines it with its sampling state. The IR keeps textures and
// samplers apart; each (texture, sampler) pair sampled together becomes one
// combined sampler, bound to its own texture unit at draw time. A texture
// read by textureLoad (texelFetch) has one too, without sampler: the backend
// binds a sampler object that only makes it complete (nearest, no compare).
export interface CombinedSampler {
  // Name of the uniform in the generated code.
  readonly name: string;
  // Names of the texture and sampler bindings in the layout; no sampler for
  // the textures read by textureLoad.
  readonly texture: string;
  readonly sampler?: string;
  readonly type: TextureType;
  // A comparison sampler (shadow maps): a sampler2DShadow.
  readonly comparison: boolean;
}

// The uniform of the orientation of a 2d texture (undefined for the other
// types): a vec2 (a, b), its v read as a + b × v. 2d textures are stored
// bottom row first when they are uploaded flipped or rendered to, (1, -1);
// top row first for the compressed ones, whose blocks cannot be flipped,
// (0, 1) (see WebGl2Texture.flipped). Set by the pipeline at draw time.
export const orientationUniform = (
  sampler: CombinedSampler,
): string | undefined =>
  sampler.type.dimension === '2d' ? `${sampler.name}_v` : undefined;

// The pairs sampled by a program, in order of first use (vertex stage
// first): the same order for the code generator and the pipeline.
export function combinedSamplers(
  module: ShaderModuleIR,
  layout: PhysicalProgramLayout,
): CombinedSampler[] {
  const textureTypes = new Map<string, TextureType>();
  const comparisonSamplers = new Set<string>();
  for (const group of layout.groups) {
    for (const { resource } of group.bindings) {
      if (resource.kind === 'texture') {
        textureTypes.set(resource.name, resource.type);
      } else if (resource.kind === 'sampler' && resource.comparison) {
        comparisonSamplers.add(resource.name);
      }
    }
  }

  const pairs = new Map<string, CombinedSampler>();
  for (const entryPoint of module.entryPoints) {
    const instructions: IrInstruction[] = [];
    forEachInstruction(entryPoint.body, (instruction) =>
      instructions.push(instruction),
    );
    const byId = new Map<number, IrInstruction>(
      instructions.map((instruction) => [instruction.id, instruction]),
    );
    const bindingOf = (id: number): string => {
      const op = byId.get(id)?.op;
      if (op?.kind !== 'load-resource') {
        throw new Error(
          `Value ${id} is sampled but does not come from a binding`,
        );
      }
      return op.binding;
    };
    for (const instruction of instructions) {
      const kind = instruction.op.kind;
      if (
        kind !== 'sample' &&
        kind !== 'sample-level' &&
        kind !== 'sample-compare' &&
        kind !== 'texture-load'
      ) {
        continue;
      }
      const texture = bindingOf(instruction.args[0]);
      const sampler =
        kind === 'texture-load' ? undefined : bindingOf(instruction.args[1]);
      const key = `${texture}|${sampler ?? ''}`;
      if (pairs.has(key)) {
        continue;
      }
      const type = textureTypes.get(texture);
      if (!type) {
        throw new Error(`Texture "${texture}" is not in the layout`);
      }
      pairs.set(key, {
        // The index keeps names distinct whatever the binding names.
        name: `ts${pairs.size}_${texture}_${sampler ?? 'load'}`.replace(
          /_{2,}/g,
          '_',
        ),
        texture,
        ...(sampler !== undefined ? { sampler } : {}),
        type,
        comparison: sampler !== undefined && comparisonSamplers.has(sampler),
      });
    }
  }
  return [...pairs.values()];
}
