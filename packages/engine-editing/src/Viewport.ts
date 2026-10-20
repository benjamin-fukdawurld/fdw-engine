import type { Camera } from '@fdw/engine-core';
import { Ray, type ReadonlyVec3, type Vec3 } from '@fdw/engine-geometry';
import { conjugate, type Quat, rotate } from './math';

/** A point of the viewport, in pixels from its top left corner. */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * What a camera shows in a region of pixels: the rays under the pointer,
 * the projection of points, the size of a pixel at a distance. The tools
 * work in pixels of the target the scene is drawn into (those of the
 * texture of identifiers): convert the CSS pixels of the pointer events by
 * the ratio of the canvas (see pointerPixel).
 *
 * The camera is read at each call: it can move between two.
 */
export class Viewport {
  constructor(
    public camera: Camera,
    public width = 1,
    public height = 1,
  ) {}

  /** Changes the size, in pixels. */
  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  private get rotation(): Quat {
    const { x, y, z, w } = this.camera.rotation;
    return [x, y, z, w];
  }

  private get position(): Vec3 {
    const { x, y, z } = this.camera.position;
    return [x, y, z];
  }

  /** The direction the camera looks at, in the world (its -z axis). */
  get forward(): Vec3 {
    return rotate(this.rotation, [0, 0, -1]);
  }

  /** The ray from the camera through a point of the viewport. */
  ray({ x, y }: ViewportPoint): Ray {
    // Normalized device coordinates, y up.
    const nx = (2 * x) / this.width - 1;
    const ny = 1 - (2 * y) / this.height;
    const projection = this.camera.projection;
    const rotation = this.rotation;
    if (projection.type === 'perspective') {
      const t = Math.tan((projection.fov * Math.PI) / 360);
      const direction = rotate(rotation, [
        nx * t * projection.aspect,
        ny * t,
        -1,
      ]);
      return new Ray(this.position, direction);
    }
    const { left, right, bottom, top } = projection;
    const offset = rotate(rotation, [
      left + ((nx + 1) / 2) * (right - left),
      bottom + ((ny + 1) / 2) * (top - bottom),
      0,
    ]);
    const p = this.position;
    return new Ray(
      [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]],
      rotate(rotation, [0, 0, -1]),
    );
  }

  /** The point in the space of the camera: x right, y up, looking along -z. */
  private toView(point: ReadonlyVec3): Vec3 {
    const p = this.position;
    return rotate(conjugate(this.rotation), [
      point[0] - p[0],
      point[1] - p[1],
      point[2] - p[2],
    ]);
  }

  /**
   * Where a point of the world is on the viewport, in pixels, and its
   * distance in front of the camera (`depth`, negative behind it).
   */
  project(point: ReadonlyVec3): { x: number; y: number; depth: number } {
    const [vx, vy, vz] = this.toView(point);
    const depth = -vz;
    const projection = this.camera.projection;
    let nx: number;
    let ny: number;
    if (projection.type === 'perspective') {
      const t = Math.tan((projection.fov * Math.PI) / 360);
      const d = Math.abs(depth) < 1e-9 ? 1e-9 : depth;
      nx = vx / (d * t * projection.aspect);
      ny = vy / (d * t);
    } else {
      const { left, right, bottom, top } = projection;
      nx = ((vx - left) / (right - left)) * 2 - 1;
      ny = ((vy - bottom) / (top - bottom)) * 2 - 1;
    }
    return {
      x: ((nx + 1) / 2) * this.width,
      y: ((1 - ny) / 2) * this.height,
      depth,
    };
  }

  /**
   * The size of a pixel at a point, in units of the world: what keeps an
   * object (a gizmo) the same size on screen, wherever it is.
   */
  worldPerPixel(point: ReadonlyVec3): number {
    const projection = this.camera.projection;
    if (projection.type === 'perspective') {
      const depth = Math.max(-this.toView(point)[2], projection.near);
      return (
        (2 * depth * Math.tan((projection.fov * Math.PI) / 360)) / this.height
      );
    }
    return Math.abs(projection.top - projection.bottom) / this.height;
  }

  /** The unit direction from the camera to a point (its forward, in orthographic). */
  direction(point: ReadonlyVec3): Vec3 {
    if (this.camera.projection.type !== 'perspective') {
      return this.forward;
    }
    const p = this.position;
    const d: Vec3 = [point[0] - p[0], point[1] - p[1], point[2] - p[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    return l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : this.forward;
  }
}

/**
 * The pixel of a canvas under a pointer event (its CSS offset scaled by the
 * size of the canvas in pixels): the coordinates the tools take.
 */
export function pointerPixel(
  event: { readonly offsetX: number; readonly offsetY: number },
  canvas: {
    readonly width: number;
    readonly height: number;
    readonly clientWidth: number;
    readonly clientHeight: number;
  },
): ViewportPoint {
  return {
    x: (event.offsetX * canvas.width) / Math.max(1, canvas.clientWidth),
    y: (event.offsetY * canvas.height) / Math.max(1, canvas.clientHeight),
  };
}
