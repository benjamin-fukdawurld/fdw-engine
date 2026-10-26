import type { GpuBindGroupEntry, GpuBuffer } from '@fdw/engine-backend';

/**
 * The vertices of a mesh moved on the GPU (Material.deformedVertices):
 * `stride` vec4 per vertex in a storage buffer, in the order of the
 * vertices of the mesh, the position first (xyz), the normal and the
 * tangent at their vec4 when there. The traced scene refits the structure
 * of the mesh to them, and reads its hits there.
 */
export interface DeformedVertices {
  readonly buffer: GpuBuffer;
  readonly stride: number;
  readonly normal?: number;
  readonly tangent?: number;
}

/**
 * A scene traced by rays, as the renderer binds it: its acceleration
 * structure and the buffers of its hits, the 'frame' resources `scene`,
 * `rayInstances` and `rayGeometry` of the programs (see
 * RayInstanceVec4s of @fdw/engine-shader). A RayScene of
 * @fdw/engine-raytracing, updated before the frame.
 */
export interface TracedScene {
  /** A resource of the scene, by its name in the programs. */
  resource(name: string): GpuBindGroupEntry['resource'] | undefined;
  /**
   * Changes when the resources change (a buffer grew, the structure was
   * replaced): the bind groups holding them are made again.
   */
  readonly version: number;
}

/**
 * What a view traces with rays, on the backends with the rayQuery
 * capability (see RenderOptions.rays).
 */
export interface RayTracingOptions {
  /** The scene the rays are traced against. */
  readonly scene: TracedScene;
  /**
   * Shadows traced towards the lights that cast shadows (castShadow),
   * instead of the shadow maps: hard with one sample, soft with more (the
   * size of the light: `shadow.softness`). Default false.
   */
  readonly shadows?: boolean | RayShadowOptions;
}

export interface RayShadowOptions {
  /** Rays per light and pixel (1: hard shadows). Default 1. */
  readonly samples?: number;
  /**
   * How far the rays start from the surface, along its normal, in world
   * units: against the acne of the rays leaving the surface they start
   * from. Default 0.02.
   */
  readonly offset?: number;
}

/** The ray shadows of a view, resolved: undefined without. */
export function rayShadowsOf(
  options: RayTracingOptions | undefined,
): Required<RayShadowOptions> | undefined {
  const shadows = options?.shadows;
  if (!shadows) {
    return undefined;
  }
  const given = shadows === true ? {} : shadows;
  return {
    samples: Math.max(1, Math.round(given.samples ?? 1)),
    offset: given.offset ?? 0.02,
  };
}
