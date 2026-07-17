/**
 * Core math and primitive types for the 3D engine.
 * These are domain-agnostic — usable by any 3D application (CAD, game, viz).
 */

/** 2D vector */
export type Vec2 = {
  x: number;
  y: number;
};

/** 3D vector */
export type Vec3 = Vec2 & {
  z: number;
};

export type Vec4 = Vec3 & {
  w: number;
};

/** RGBA color (0-1 range) */
export type Color = {
  r: number;
  g: number;
  b: number;
  a: number;
};

/** Axis-aligned bounding box */
export type BoundingBox = {
  min: Vec3;
  max: Vec3;
};

export type Transform = {
  position: Vec3;
  rotation: Vec4; // Quaternion
  scale: Vec3;
};
