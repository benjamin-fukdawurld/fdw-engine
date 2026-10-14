import { Camera, DirectionalLight, Renderer } from '@fdw/engine-core';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import { multiplyQuat, rotationAround } from '../maze/quaternions';
import { followAspect, SceneFactory } from '../scene';
import { buildTerrain, TerrainOptions } from './terrain';

/**
 * A terrain of hills and ridges, flown over: its patches tessellated on
 * the fly, finely near the camera, coarsely far away. Keys: L colors the
 * patches by level, T draws every patch at the finest level instead, to
 * compare.
 */
export function createTerrain(options: TerrainOptions = {}): SceneFactory {
  return (backend, surface, context = {}) => {
    const terrain = buildTerrain(backend, options);
    const uniform = buildTerrain(backend, { ...options, minLevel: 6 });
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 60,
        aspect: 1,
        near: 0.5,
        far: 4000,
      },
    });
    const sun = new DirectionalLight({
      direction: { x: -0.5, y: -0.6, z: -0.4 },
      ambient: { x: 0.3, y: 0.32, z: 0.38 },
      diffuse: { x: 1, y: 0.95, z: 0.85 },
      specular: { x: 0.3, y: 0.3, z: 0.3 },
    });
    const renderer = new Renderer(backend, {
      output: { toneMapping: 'neutral', encoding: 'srgb' },
    });
    const input = new Input(context.input ?? new FakeInputSource());
    const actions = new ActionMap(input, {
      levels: { type: 'button', bindings: ['key:KeyL', 'gamepad:north'] },
      adaptive: { type: 'button', bindings: ['key:KeyT', 'gamepad:west'] },
    });
    let levels = false;
    let adaptive = true;
    let last = 0;
    let frameTime = 1 / 60;

    return {
      frame: (time) => {
        const dt = Math.min(time - last, 0.1);
        last = time;
        frameTime += (dt - frameTime) * 0.1;
        input.update();
        if (actions.button('levels').pressed) {
          levels = !levels;
          terrain.showLevels(levels);
          uniform.showLevels(levels);
        }
        if (actions.button('adaptive').pressed) {
          adaptive = !adaptive;
        }

        // A circle over the hills, 30 m above the ground here and 60 m ahead,
        // looking ahead.
        const angle = time * 0.04;
        const radius = terrain.size * 0.3;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const ground = Math.max(
          terrain.heightAt(x, z),
          terrain.heightAt(x - Math.sin(angle) * 60, z + Math.cos(angle) * 60)
        );
        camera.position = { x, y: ground + 30, z };
        camera.rotation = multiplyQuat(
          rotationAround('y', Math.PI - angle),
          rotationAround('x', -0.25)
        );
        followAspect(camera, surface);

        const shown = adaptive ? terrain : uniform;
        shown.surface.update(camera, surface);
        renderer.render({
          items: [shown.surface],
          camera,
          surface,
          lights: [sun],
          clearColor: { r: 0.62, g: 0.74, b: 0.88, a: 1 },
        });

        const stats = shown.surface.stats;
        context.info?.(
          `${stats.drawn} of ${stats.patches} patches, ${Math.round(
            stats.triangles / 1000
          )}k triangles — levels (L) — ${
            adaptive && (options.minLevel ?? 0) < 6
              ? 'adaptive'
              : 'finest everywhere'
          } (T) — ${Math.round(1 / Math.max(frameTime, 1e-3))} fps`
        );
      },
      destroy: () => {
        input.dispose();
        terrain.destroy();
        uniform.destroy();
        renderer.destroy();
      },
    };
  };
}

/** The terrain, tessellated by the size of its patches on the screen. */
export const createTerrainScene: SceneFactory = createTerrain();
