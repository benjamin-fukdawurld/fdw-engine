import type { RenderBackend, Surface } from '@fdw/engine-backend';
import type { Camera } from '@fdw/engine-core';

// A demo scene, independent of where it runs: a browser canvas (the routes)
// or a native window (apps/demo-native).
export interface Scene {
  // Renders a frame; time in seconds since the start.
  frame(time: number): void;
  destroy(): void;
}

export type SceneFactory = (backend: RenderBackend, surface: Surface) => Scene;

// Keeps the aspect of a perspective camera equal to the one of the surface,
// whose size can change (a resized window).
export function followAspect(camera: Camera, surface: Surface): void {
  const projection = camera.projection;
  const aspect = surface.width / Math.max(surface.height, 1);
  if (projection.type === 'perspective' && projection.aspect !== aspect) {
    camera.projection = { ...projection, aspect };
  }
}
