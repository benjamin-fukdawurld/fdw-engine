import type { IVec3, Mat4 } from '@fdw/engine-backend';
import type { Aabb } from '@fdw/engine-geometry';
import type { GraphBuilder, PortHandle } from '@fdw/engine-shader';
import type { RenderGraph, TextureHandle } from '../graph/RenderGraph';
import type { MaterialValue } from './Material';
import type { Renderer } from './Renderer';
import type { Renderable } from './RenderSource';

/** The camera of a view, as the scene passes draw it. */
export interface OcclusionView {
  // The prefix of the scene passes ('scene').
  readonly name: string;
  readonly position: Readonly<IVec3>;
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly viewProjection: Mat4;
}

/** What the passes testing the items are given, after the opaque items. */
export interface OcclusionPassContext {
  readonly renderer: Renderer;
  // The prefix of the scene passes: the names of the passes added start
  // with it.
  readonly name: string;
  // The depth of the opaque items, as their pass wrote it.
  readonly depth: TextureHandle;
  // Its samples per pixel.
  readonly samples: number;
}

/**
 * The depth pyramid of the opaque items drawn so far, for the second phase
 * of the occlusion culling on the GPU (see OcclusionCuller.addPyramid): the
 * culling of the scene passes tests the box of each candidate against it,
 * in the compute graph it builds.
 */
export interface OcclusionPyramid {
  // The levels, finest first: read by the compute pass of the test.
  readonly levels: readonly TextureHandle[];
  // The name of the texture of each level in the graph of the test.
  readonly names: readonly string[];
  // What the graph of the test depends on (the number of levels): a
  // compiled test per key.
  readonly key: string;
  // The values of the uniforms of the test this frame.
  readonly values: Readonly<Record<string, MaterialValue>>;
  /**
   * Adds to a compute graph the test of a box, its corners in the world
   * (vec3f): true where it may be visible, false where the opaque items
   * hide it.
   */
  test(g: GraphBuilder, low: PortHandle, high: PortHandle): PortHandle;
}

/**
 * A stage of the visibility of a camera view, after the frustum: the scene
 * passes given it (option `occlusion`) ask it, for each item the source
 * gives for the camera, whether the item may be visible, then let it add
 * the passes that find what the opaque items hide. Implemented by the
 * OcclusionCulling of @fdw/engine-occlusion; one per view.
 */
export interface OcclusionCuller {
  /** A new frame of the view: called before the source is queried. */
  begin(view: OcclusionView): void;
  /**
   * Whether an item the source gives for the camera may be visible: false
   * leaves it out of the view. Its world bounds, when it has some.
   */
  visible(item: Renderable, bounds: Aabb | undefined): boolean;
  /** Adds the passes testing the items, once the opaque items are drawn. */
  addPasses(graph: RenderGraph, context: OcclusionPassContext): void;
  /**
   * The occlusion culling on the GPU, in two phases without delay (with
   * the culling on the GPU of the scene passes, option gpuCulling): adds
   * the passes building the depth pyramid of the opaque items drawn in the
   * first phase (those visible at the previous frame), and returns what the
   * second phase tests the others against. Called after begin(), instead of
   * visible() and addPasses(). Optional: without it, the scene passes use
   * the results of addPasses.
   */
  addPyramid?(
    graph: RenderGraph,
    context: OcclusionPassContext,
  ): OcclusionPyramid;
}
