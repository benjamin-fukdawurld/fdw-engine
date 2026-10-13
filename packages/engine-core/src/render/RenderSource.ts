import type { Mat4 } from '@fdw/engine-backend';
import type { Aabb, Frustum } from '@fdw/engine-geometry';
import type { BaseLight } from '../light';
import type { Transform } from '../Transform';
import type { Material } from './Material';
import type { Mesh } from './Mesh';

/** A world matrix computed outside of the renderer (a scene graph). */
export interface WorldTransform {
  readonly matrix: Mat4;
  // Changes whenever the matrix does: the renderer uploads it only then.
  readonly version: number;
}

interface RenderItemBase {
  readonly mesh: Mesh;
  readonly material: Material;
  // Drawn into the shadow maps of the lights. Default true; transparent
  // items never cast shadows.
  readonly castShadow?: boolean;
  // An identifier of the object, from 1 to 2^24 (MaxObjectId), written by
  // the 'object-id' outputs of the scene passes for its pixels (0: none):
  // to find what is under the mouse. The items sharing a transform or a
  // world matrix are one object: they share it.
  readonly id?: number;
  // The world bounds, when the source knows them; otherwise computed from
  // the mesh and the world matrix.
  readonly bounds?: Aabb;
}

/** A mesh drawn with a material, placed by a Transform. */
export interface RenderItem extends RenderItemBase {
  // Its local matrix is the world matrix.
  readonly transform: Transform;
}

/** A mesh drawn with a material, placed by a world matrix computed elsewhere. */
export interface WorldRenderItem extends RenderItemBase {
  readonly world: WorldTransform;
}

/** What the renderer draws: an item placed by a Transform or a world matrix. */
export type Renderable = RenderItem | WorldRenderItem;

/**
 * Where the renderer finds what to draw: queried for each view (the camera,
 * the shadow maps of the lights), with the volume the view sees. A scene
 * graph answers from its spatial index; a list of items, by testing each.
 */
export interface RenderSource {
  /**
   * Calls `visit` for each item whose bounds may touch the frustum, among
   * those whose layers intersect `layers`. `view` says what the query is
   * for: what a camera sees (where a source can cull what is hidden, and
   * remember what was seen), or the casters of a shadow map (which must
   * not be culled by what the camera does not see).
   */
  query(
    frustum: Frustum,
    layers: number,
    visit: (item: Renderable) => void,
    view: 'camera' | 'shadow'
  ): void;
  /** The lights of the source, when the frame does not give its own. */
  lights?(): Iterable<BaseLight>;
  /**
   * The bounds of all the items, written into `out`: how far shadow
   * casters can be from what the camera sees. Without it, the shadows of
   * the lights reach a few times the size of the visible region.
   */
  bounds?(out: Aabb): Aabb;
}

/** Every layer: the default mask of the views. */
export const AllLayers = 0xffffffff;
