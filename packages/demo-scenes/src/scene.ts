import type { RenderBackend, Surface } from '@fdw/engine-backend';
import type { Camera } from '@fdw/engine-core';

// A demo scene, independent of where it runs: a browser canvas (the routes)
// or a native window (apps/demo-native).
export interface Scene {
  // Renders a frame; time in seconds since the start.
  frame(time: number): void;
  destroy(): void;
}

/** What a scene can use from where it runs, besides the backend and the surface. */
export interface SceneContext {
  // The target of the keyboard and mouse events: a browser window, a
  // canvas, a native window.
  readonly input?: EventTarget;
  // Shows a line of information (statistics): an overlay, a window title.
  readonly info?: (text: string) => void;
}

export type SceneFactory = (
  backend: RenderBackend,
  surface: Surface,
  context?: SceneContext
) => Scene;

// Keeps the aspect of a perspective camera equal to the one of the surface,
// whose size can change (a resized window).
export function followAspect(camera: Camera, surface: Surface): void {
  const projection = camera.projection;
  const aspect = surface.width / Math.max(surface.height, 1);
  if (projection.type === 'perspective' && projection.aspect !== aspect) {
    camera.projection = { ...projection, aspect };
  }
}
