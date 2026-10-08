import type { PhysicalProgramLayout } from '@fdw/engine-backend';
import type {
  IrInstruction,
  ShaderModuleIR,
  TextureType,
} from '@fdw/engine-shader';

// GLSL ES has no separate samplers: a texture is sampled through a sampler2D
// that combines it with its sampling state. The IR keeps textures and
// samplers apart; each (texture, sampler) pair sampled together becomes one
// combined sampler, bound to its own texture unit at draw time.
export interface CombinedSampler {
  // Name of the uniform in the generated code.
  readonly name: string;
  // Names of the texture and sampler bindings in the layout.
  readonly texture: string;
  readonly sampler: string;
  readonly type: TextureType;
}

// The pairs sampled by a program, in order of first use (vertex stage
// first): the same order for the code generator and the pipeline.
export function combinedSamplers(
  module: ShaderModuleIR,
  layout: PhysicalProgramLayout
): CombinedSampler[] {
  const textureTypes = new Map<string, TextureType>();
  for (const group of layout.groups) {
    for (const { resource } of group.bindings) {
      if (resource.kind === 'texture') {
        textureTypes.set(resource.name, resource.type);
      }
    }
  }

  const pairs = new Map<string, CombinedSampler>();
  for (const entryPoint of module.entryPoints) {
    const byId = new Map<number, IrInstruction>(
      entryPoint.body.map((instruction) => [instruction.id, instruction])
    );
    const bindingOf = (id: number): string => {
      const op = byId.get(id)?.op;
      if (op?.kind !== 'load-resource') {
        throw new Error(
          `Value ${id} is sampled but does not come from a binding`
        );
      }
      return op.binding;
    };
    for (const instruction of entryPoint.body) {
      if (instruction.op.kind !== 'sample') {
        continue;
      }
      const texture = bindingOf(instruction.args[0]);
      const sampler = bindingOf(instruction.args[1]);
      const key = `${texture}|${sampler}`;
      if (pairs.has(key)) {
        continue;
      }
      const type = textureTypes.get(texture);
      if (!type) {
        throw new Error(`Texture "${texture}" is not in the layout`);
      }
      pairs.set(key, {
        // The index keeps names distinct whatever the binding names.
        name: `ts${pairs.size}_${texture}_${sampler}`.replace(/_{2,}/g, '_'),
        texture,
        sampler,
        type,
      });
    }
  }
  return [...pairs.values()];
}
