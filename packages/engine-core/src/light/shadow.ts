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
