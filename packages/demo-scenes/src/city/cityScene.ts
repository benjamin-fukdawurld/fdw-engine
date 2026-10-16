import {
  Camera,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import { OcclusionCulling } from '@fdw/engine-occlusion';
import { Scene } from '@fdw/engine-scene';
import { createSphere } from '../geometry';
import { TopViewLayer } from '../maze/topView';
import { multiplyQuat, rotationAround } from '../maze/quaternions';
import { surfaceMaterial } from '../maze/world';
import { followAspect, SceneFactory } from '../scene';
import { buildCity, CityPlan, defaultCityPlan } from './city';
import { CullingView } from './cullingView';

export interface CityOptions {
  readonly plan?: CityPlan;
  // The occlusion culling at the start. Default true.
  readonly occlusion?: boolean;
  // The view of the culling in a corner at the start. Default true.
  readonly cullingView?: boolean;
  // The shadows of the sun. Default true.
  readonly shadows?: boolean;
}

function cityActions(input: Input): ActionMap {
  return new ActionMap(input, {
    move: {
      type: 'vector',
      bindings: [
        {
          up: 'key:KeyW',
          down: 'key:KeyS',
          left: 'key:KeyA',
          right: 'key:KeyD',
        },
        {
          up: 'key:ArrowUp',
          down: 'key:ArrowDown',
          left: 'key:ArrowLeft',
          right: 'key:ArrowRight',
        },
        'gamepad:leftStick',
      ],
    },
    run: { type: 'button', bindings: ['key:ShiftLeft', 'key:ShiftRight'] },
    // Positive to the left.
    turn: {
      type: 'axis',
      bindings: [
        { negative: 'key:KeyE', positive: 'key:KeyQ' },
        { negative: 'gamepad:rightShoulder', positive: 'gamepad:leftShoulder' },
      ],
    },
    // Up (negative) or down: the wheel.
    height: { type: 'axis', bindings: ['pointer:wheel'] },
    occlusion: { type: 'button', bindings: ['key:KeyO', 'gamepad:north'] },
    culling: { type: 'button', bindings: ['key:KeyC', 'gamepad:back'] },
  });
}

/**
 * A city of thousands of buildings, seen from its streets, with the
 * occlusion culling: the buildings along the street hide almost all the
 * others. A corner shows the culling from above: light what is drawn, red
 * what the occlusion culling left out.
 *
 * The camera drives along an avenue, looking around, until a key moves it.
 * Keys: WASD (or the arrows) to move, Q and E to turn, the wheel to rise,
 * Shift to go faster; O switches the occlusion culling, C the view of the
 * culling.
 */
export function createCity(options: CityOptions = {}): SceneFactory {
  return (backend, surface, context = {}) => {
    const scene = new Scene();
    const city = buildCity(scene, options.plan ?? defaultCityPlan);
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 60,
        aspect: 1,
        near: 0.5,
        far: 2000,
      },
    });
    const cameraNode = scene.root.add({ name: 'camera' }).setCamera(camera);
    const marker = scene.root
      .add({
        name: 'marker',
        layers: TopViewLayer,
        scale: { x: 14, y: 14, z: 14 },
      })
      .setMesh(createSphere(16, 8), surfaceMaterial([1, 0.5, 0.05], 0.5), {
        castShadow: false,
      });

    const renderer = new Renderer(backend, {
      output: { toneMapping: 'neutral', encoding: 'srgb' },
    });
    const runner = new RenderGraphRunner(backend);
    const occlusion = new OcclusionCulling();
    const cullingView = new CullingView(renderer, scene, occlusion, backend);
    const input = new Input(context.input ?? new FakeInputSource());
    const actions = cityActions(input);

    // The avenue in the middle; then where the keys take the camera.
    const avenue = city.streets[Math.floor(city.streets.length / 2)];
    const position = { x: avenue, y: 2, z: city.half };
    let yaw = 0;
    let manual = false;
    let occlusionOn = options.occlusion ?? true;
    let showCulling = options.cullingView ?? true;
    let last = 0;
    let frameTime = 1 / 60;

    const move = (time: number, dt: number) => {
      const { x: right, y: forward } = actions.vector('move');
      const turn = actions.axis('turn');
      const rise = actions.axis('height');
      manual ||= right !== 0 || forward !== 0 || turn !== 0 || rise !== 0;
      if (!manual) {
        // Down the avenue at 50 km/h, looking left and right.
        const length = 2 * city.half;
        position.x = avenue;
        position.z = city.half - ((time * 14) % length);
        yaw = Math.sin(time * 0.4) * 0.6;
        return;
      }
      const speed = (actions.button('run').down ? 60 : 15) * dt;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      position.x += (right * cos - forward * sin) * speed;
      position.z += (-right * sin - forward * cos) * speed;
      yaw += turn * 1.5 * dt;
      position.y = Math.min(
        300,
        Math.max(1.7, position.y * Math.exp(-rise * 0.1)),
      );
    };

    return {
      frame: (time) => {
        const dt = Math.min(time - last, 0.1);
        last = time;
        frameTime += (dt - frameTime) * 0.1;
        input.update();
        if (actions.button('occlusion').pressed) {
          occlusionOn = !occlusionOn;
        }
        if (actions.button('culling').pressed) {
          showCulling = !showCulling;
        }
        move(time, dt);
        cameraNode.transform.position = position;
        // Looking slightly up along the street.
        cameraNode.transform.rotation = multiplyQuat(
          rotationAround('y', yaw),
          rotationAround('x', 0.08),
        );
        marker.transform.position = { x: position.x, y: 1, z: position.z };
        followAspect(camera, surface);

        const current = surface.getCurrentTarget();
        const graph = new RenderGraph({
          size: { width: current.width, height: current.height },
        });
        const output = graph.importTexture('surface', current);
        const main = renderer.addScenePasses(graph, {
          source: scene,
          camera,
          layers: ~TopViewLayer,
          target: output,
          format: surface.format,
          clearColor: { r: 0.55, g: 0.68, b: 0.85, a: 1 },
          shadows: options.shadows ?? true,
          ...(occlusionOn ? { occlusion } : {}),
        });
        if (showCulling) {
          cullingView.add(
            graph,
            main.color,
            surface,
            position,
            scene.cameraQueries,
          );
        }
        runner.execute(graph);
        surface.present();

        const stats = renderer.stats.get('scene');
        if (stats) {
          const inView = stats.visible + stats.occluded;
          context.info?.(
            `${stats.visible} drawn of ${inView} in view (${city.buildings.length} buildings), ` +
              `${stats.occluded} hidden — occlusion ${
                occlusionOn ? 'on' : 'off'
              } (O) — ` +
              `${Math.round(1 / Math.max(frameTime, 1e-3))} fps`,
          );
        }
      },
      destroy: () => {
        input.dispose();
        occlusion.destroy();
        runner.destroy();
        renderer.destroy();
      },
    };
  };
}

/** The city, with the occlusion culling and the view of the culling. */
export const createCityScene: SceneFactory = createCity();
