import type { IVec3, Mat4 } from '@fdw/engine-backend';
import type { Aabb } from '@fdw/engine-geometry';
import type { RenderGraph, TextureHandle } from '../graph/RenderGraph';
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
}
