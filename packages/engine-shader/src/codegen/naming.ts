import type { IrInstruction } from '../compiler/ir';
import type { LogicalBinding } from '../compiler/layout';

// The names shared by the code generators (WGSL, GLSL ES, HLSL), so that a
// resource has the same identifier in every language.

/**
 * A text made a valid identifier in every target language: the characters
 * other than letters, digits and _ become _, the leading _ are removed, and
 * runs of _ are merged (GLSL reserves the identifiers containing "__"). The
 * compiler rejects the resource names containing "__", so two names never
 * collapse to the same identifier.
 *
 * @group Codegen
 */
export const sanitizeIdentifier = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^_+/, '')
    .replace(/_{2,}/g, '_');

/**
 * The name of the struct or block of a binding: materialUniforms →
 * MaterialUniforms.
 *
 * @group Codegen
 */
export const structName = (name: string): string =>
  name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The identifier of a member chosen by the user (uniforms): prefixed, so that
 * it collides neither with the keywords and reserved words of the languages
 * ('from', 'type'…) nor with their builtin functions ('min', 'normalize'…).
 *
 * @group Codegen
 */
export const memberIdentifier = (name: string): string =>
  sanitizeIdentifier(`u_${name}`);

/**
 * The identifier of a resource. The names chosen by the user are prefixed by
 * their kind; the uniform blocks and the object table, named by the compiler,
 * are kept as is.
 *
 * @group Codegen
 */
export function resourceIdentifier(resource: LogicalBinding): string {
  switch (resource.kind) {
    case 'uniform-block':
      return resource.name;
    case 'texture':
      return `t_${resource.name}`;
    case 'sampler':
      return `s_${resource.name}`;
    case 'storage-buffer':
      return `b_${resource.name}`;
    case 'object-table':
      return resource.name;
    case 'acceleration-structure':
      return `as_${resource.name}`;
  }
}

/**
 * The buffers of an acceleration structure traversed in software.
 *
 * @group Codegen
 */
export const accelerationBuffers = (
  name: string,
): { readonly top: string; readonly bottom: string } => ({
  top: `${name}_top`,
  bottom: `${name}_bottom`,
});

/**
 * The second buffer of an object table: the row of each instance.
 *
 * @group Codegen
 */
export const instancesIdentifier = (table: string): string =>
  `${table}Instances`;

/**
 * The name of the value of an instruction: v12, or v12_label when the
 * instruction has a label.
 *
 * @group Codegen
 */
export const valueName = (instruction: IrInstruction): string =>
  `v${instruction.id}${
    instruction.name ? `_${sanitizeIdentifier(instruction.name)}` : ''
  }`;
