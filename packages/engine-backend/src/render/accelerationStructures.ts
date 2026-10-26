import type { GpuBuffer } from '../gpu';

// The acceleration structures that rays are traced against (ray.trace), on
// the backends with the rayQuery capability: built by the GPU (Vulkan), or
// by the backend on the CPU and traversed by code it generates (WebGPU).
// Two levels, as in the hardware APIs: a bottom level per mesh, a top level
// of the instances of the meshes, rebuilt each frame.

/** The triangles of a bottom level structure. */
export interface BottomLevelDescriptor {
  /** xyz per vertex, in the space of the object. */
  readonly positions: Float32Array<ArrayBuffer>;
  /** 3 per triangle: indices of the positions. */
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly label?: string;
  /**
   * Its vertices move on the GPU (a skinned character): the structure can
   * be refit to them (GpuCommandEncoder.refitBottomLevel), its triangles
   * kept. Default false.
   */
  readonly dynamic?: boolean;
}

/**
 * Where the positions of a dynamic bottom level are on the GPU: xyz
 * (float32) of the vertex v at offset + v × stride bytes of a storage
 * buffer, in the order of the positions it was created from.
 */
export interface BottomLevelVertices {
  readonly buffer: GpuBuffer;
  readonly offset?: number;
  readonly stride: number;
}

/**
 * The structure of a mesh, built at its creation from its triangles. The
 * triangle reported by a hit is the index of the triangle in its indices.
 */
export interface GpuBottomLevel {
  readonly triangleCount: number;
  readonly label?: string;
  /**
   * Frees it, once the top levels that hold it are updated without it and
   * the commands using them are done (the backends keep it alive until
   * then).
   */
  destroy(): void;
}

/** An instance of a mesh in a top level structure. */
export interface TopLevelInstance {
  readonly bottom: GpuBottomLevel;
  /** Object to world, column-major 4 × 4 (only its affine part is used). */
  readonly transform: ArrayLike<number>;
  /** 8 bits: the rays whose mask shares a bit with it see it (0xff). */
  readonly mask?: number;
  /**
   * The box of the instance in the world (min xyz, max xyz) when its bottom
   * level is refit on the GPU: the backends that build the top level on the
   * CPU (WebGPU) cannot read it there. Default: the box of the bottom level
   * as created, transformed.
   */
  readonly bounds?: ArrayLike<number>;
  /**
   * Whether its hits are taken as found (default true). The candidate
   * hits of an instance that is not opaque are tested by the programs
   * tracing with an alpha test (ray.traceAlpha), and taken as found by
   * the others.
   */
  readonly opaque?: boolean;
}

export interface TopLevelDescriptor {
  /** The instances it can hold at first; it grows when given more. */
  readonly capacity?: number;
  readonly label?: string;
}

/**
 * The structure of a scene: instances of bottom levels, bound to the
 * programs that trace rays (an 'acceleration-structure' binding). A hit
 * reports the index of its instance in the last update.
 *
 * Each frame: update(instances), then GpuCommandEncoder.buildTopLevel in
 * the commands submitted before the passes that trace rays against it.
 */
export interface GpuTopLevel {
  readonly label?: string;
  /** The number of instances of the last update. */
  readonly instanceCount: number;
  /**
   * Changes when the bind groups holding the structure must be made again:
   * the memory of the structure was replaced (it grew).
   */
  readonly version: number;
  /** Sets the instances, for the next build. */
  update(instances: readonly TopLevelInstance[]): void;
  destroy(): void;
}
