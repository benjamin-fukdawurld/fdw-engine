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
}

export interface PhysicalBindGroup {
  readonly index: number;
  readonly slot: string;
  readonly bindings: readonly PhysicalBinding[];
}

export interface PhysicalProgramLayout {
  readonly groups: readonly PhysicalBindGroup[];
}

export interface PhysicalLayoutStrategy {
  resolve(layout: ProgramLayout): PhysicalProgramLayout;
}
