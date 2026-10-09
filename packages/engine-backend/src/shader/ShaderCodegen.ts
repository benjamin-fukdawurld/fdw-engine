import type { ShaderModuleIR } from '@fdw/engine-shader';
import type { PhysicalProgramLayout } from './PhysicalLayout';

export type ShaderLanguage =
  | 'wgsl'
  | 'glsl-es-300'
  | 'glsl-450'
  | 'msl'
  | 'hlsl'
  | 'spirv';

export type ShaderSources =
  // One module holding the entry points (WGSL, MSL, HLSL): vertex and
  // fragment, or compute.
  | {
      readonly kind: 'single-module';
      readonly code: string;
      readonly entryPoints: {
        readonly vertex?: string;
        readonly fragment?: string;
        readonly compute?: string;
      };
    }
  // One source per stage (GLSL).
  | {
      readonly kind: 'per-stage';
      readonly vertex: string;
      readonly fragment: string;
    };

// Translates the IR of a compiled program to the language of a backend.
export interface ShaderCodegen {
  readonly language: ShaderLanguage;
  emit(module: ShaderModuleIR, layout: PhysicalProgramLayout): ShaderSources;
}
