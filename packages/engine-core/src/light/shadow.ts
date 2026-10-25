import type { IVec3 } from '@fdw/engine-backend';

/**
 * How a directional or spot light casts shadows, when its `castShadow` is
 * true. The defaults suit most scenes.
 */
export interface ShadowOptions {
  /**
   * Subtracted from the depth of the points before the comparison with the
   * shadow map, in normalized depth (0 to 1 over the depth range of the
   * shadow map). Default 0: the normal offset and the slope bias of the
   * shadow pass are usually enough.
   */
  readonly bias?: number;
  /**
   * Offset of the points along their normal, in texels of the shadow map,
   * against shadow acne. Default 1.
   */
  readonly normalBias?: number;
  /**
   * Directional lights: the sphere covered by the shadow map, in world
   * space. Defaults to the bounds of the items drawn: give smaller bounds
   * for sharper shadows in a large scene.
   */
  readonly bounds?: { readonly center: IVec3; readonly radius: number };
  /**
   * Directional lights: shadow cascades instead of one shadow map. The
   * view of a perspective camera is cut in slices by depth, each covered
   * by its own shadow map: sharp shadows near the camera, coarser ones far
   * away, over a large scene. One light per frame has cascades (the first
   * with them); `bounds` is then ignored.
   */
  readonly cascades?: ShadowCascades;
  /**
   * With shadows traced by rays (RenderOptions.rays): the size of the
   * light, for soft shadows with several rays per pixel. The radius of a
   * spot light, in world units; for a directional light, the tangent of
   * its angular radius (the sun: 0.0047). Default 0: hard shadows.
   */
  readonly softness?: number;
}

/** How the shadow cascades of a directional light cut the view. */
export interface ShadowCascades {
  // Number of cascades, 1 to 4. Default 4.
  readonly count?: number;
  // How far from the camera the shadows reach (they fade out before).
  // Default: the far plane of the camera.
  readonly distance?: number;
  // How the depths of the slices grow: 0 evenly, 1 geometrically (each
  // slice a constant ratio further: the same texels on screen). Default
  // 0.75.
  readonly lambda?: number;
}

/** The shadow properties of the lights that can cast shadows. */
export interface ShadowCaster {
  // Draws the items into a shadow map of the light. Default false.
  castShadow: boolean;
  shadow: ShadowOptions;
}

/** What the constructors of the lights accept besides their data. */
export interface ShadowCasterData {
  readonly castShadow?: boolean;
  readonly shadow?: ShadowOptions;
}
