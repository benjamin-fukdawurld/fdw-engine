import { Camera, Renderer } from '@fdw/engine-core';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import { Scene, StaticBatches } from '@fdw/engine-scene';
import { multiplyQuat, rotationAround } from '../maze/quaternions';
import { followAspect, SceneFactory } from '../scene';
import { buildDecor, DecorOptions } from './decor';

export interface DecorSceneOptions extends DecorOptions {
  // The static batching at the start. Default true.
  readonly batching?: boolean;
  // The side of the cells of the batches, in meters. Default 40.
  readonly cellSize?: number;
}

/**
 * The heterogeneous set (buildDecor), flown around, with the static
 * batching: its 1 500 objects of their own meshes in about a hundred draw
 * calls instead of one each. B switches the batching.
 */
export function createDecor(options: DecorSceneOptions = {}): SceneFactory {
  return (backend, surface, context = {}) => {
    const scene = new Scene();
    const decor = buildDecor(scene, options);
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 55,
        aspect: 1,
        near: 0.3,
        far: 600,
      },
    });
    const renderer = new Renderer(backend, {
      output: { toneMapping: 'neutral', encoding: 'srgb' },
    });
    const batchOptions = { cellSize: options.cellSize ?? 40 };
    let batches =
      options.batching === false
        ? undefined
        : new StaticBatches(scene, batchOptions);
    const input = new Input(context.input ?? new FakeInputSource());
    const actions = new ActionMap(input, {
      batching: { type: 'button', bindings: ['key:KeyB', 'gamepad:north'] },
    });
    let last = 0;
    let frameTime = 1 / 60;

    return {
      frame: (time) => {
        const dt = Math.min(time - last, 0.1);
        last = time;
        frameTime += (dt - frameTime) * 0.1;
        input.update();
        if (actions.button('batching').pressed) {
          if (batches) {
            batches.destroy();
            batches = undefined;
          } else {
            batches = new StaticBatches(scene, batchOptions);
          }
        }
        // Around the square, high enough to see most of it.
        const angle = time * 0.08;
        const radius = decor.half * 0.9;
        camera.position = {
          x: Math.sin(angle) * radius,
          y: 22,
          z: Math.cos(angle) * radius,
        };
        // Looking at the center, down.
        camera.rotation = multiplyQuat(
          rotationAround('y', angle),
          rotationAround('x', -Math.atan2(22, radius)),
        );
        followAspect(camera, surface);
        renderer.render({
          source: scene,
          camera,
          surface,
          clearColor: { r: 0.62, g: 0.72, b: 0.85, a: 1 },
        });

        const stats = renderer.stats.get('scene');
        if (stats) {
          context.info?.(
            `${stats.drawCalls} draw calls for ${stats.visible} items — ${
              batches
                ? `batching on (B): ${decor.objects.length} objects in ${batches.stats.batches} batches`
                : `batching off (B): ${decor.objects.length} objects`
            } — ${Math.round(1 / Math.max(frameTime, 1e-3))} fps`,
          );
        }
      },
      destroy: () => {
        input.dispose();
        batches?.destroy();
        renderer.destroy();
      },
    };
  };
}

/** The set, batched. */
export const createDecorScene: SceneFactory = createDecor();
