/**
 * GPU Shader Module abstraction
 */

export interface GpuShaderModuleDescriptor {
  label?: string;
  /** Shader source code (WGSL for WebGPU, GLSL for WebGL, etc.) */
  code: string;
}

export interface GpuShaderModule {
  readonly label: string;
}
