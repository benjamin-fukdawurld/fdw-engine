/**
 * Abstract GPU device — the main entry point for creating GPU resources.
 */
export interface GpuDeviceLimits {
  maxTextureSize: number;
  maxBufferSize: number;
  maxBindGroups: number;
  maxVertexAttributes: number;
  maxColorAttachments: number;
}

export interface GpuDeviceDescriptor {
  /** Human-readable label for debugging */
  label?: string;
  /** Required features (optional, backend-specific) */
  requiredFeatures?: string[];
}

export abstract class GpuDevice {
  abstract readonly label: string;
  abstract readonly limits: GpuDeviceLimits;

  /** Check if the backend is available in this environment */
  abstract isAvailable(): boolean;

  /** Release all GPU resources */
  abstract destroy(): void;

  /** Get the preferred canvas texture format */
  abstract getPreferredFormat(): import('./texture').TextureFormat;
}
