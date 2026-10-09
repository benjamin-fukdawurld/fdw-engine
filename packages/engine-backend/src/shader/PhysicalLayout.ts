import type {
  LogicalBinding,
  ProgramLayout,
  ShaderType,
} from '@fdw/engine-shader';

// Physical layout of the resources of a program: binding numbers and uniform
// block offsets, following the rules of a backend.

export interface PhysicalUniformMember {
  readonly name: string;
  readonly type: ShaderType;
  readonly offset: number;
  readonly size: number;
}

export interface PhysicalUniformBlock {
  // Size of the buffer to allocate.
  readonly size: number;
  readonly members: readonly PhysicalUniformMember[];
}

export interface PhysicalBinding {
  readonly binding: number;
  readonly resource: LogicalBinding;
  // For uniform blocks only.
  readonly block?: PhysicalUniformBlock;
  // For storage buffers only: the distance in bytes between two elements of
  // the array, to fill the buffer.
  readonly storage?: { readonly elementStride: number };
}

export interface PhysicalBindGroup {
  readonly index: number;
  readonly slot: string;
  readonly bindings: readonly PhysicalBinding[];
}

export interface PhysicalProgramLayout {
  readonly groups: readonly PhysicalBindGroup[];
}

// A value written to a uniform block member: a number or boolean for
// scalars, components for vectors and matrices (column-major; a mat3 can be
// given as 9 packed floats or as 12 floats with padded columns).
export type UniformValue = number | boolean | ArrayLike<number>;

export interface PhysicalLayoutStrategy {
  resolve(layout: ProgramLayout): PhysicalProgramLayout;
  // Writes a value at the offset of a member, in the memory layout of the
  // backend.
  writeUniform(
    target: DataView,
    member: PhysicalUniformMember,
    value: UniformValue
  ): void;
}
