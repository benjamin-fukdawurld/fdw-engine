export const GpuShaderStageNames = ['vertex', 'fragment', 'compute'] as const;
export type GpuShaderStageName = (typeof GpuShaderStageNames)[number];
