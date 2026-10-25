import { OrbitActions, OrbitOperator } from '@fdw/engine-camera';
import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import type { RenderItem } from '@fdw/engine-core';
import { FluidBodies, SmokeGrid, SmokeRenderer } from '@fdw/engine-fluids';
import type { FluidBody, SmokeEmitter } from '@fdw/engine-fluids';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { createCube, createSphere } from '../geometry';
import { followAspect, SceneFactory } from '../scene';

/** The options of the smoke. */
export interface SmokeOptions {
  /** The cells of the grid along x, y and z (48 × 96 × 48). */
  readonly resolution?: readonly [number, number, number];
  /** Fire (hot smoke that rises) or smoke blown from a chimney (true). */
  readonly fire?: boolean;
  /** Where the orbit camera starts. */
  readonly view?: { yaw?: number; pitch?: number; distance?: number };
}

// The box of the smoke: 2.4 m wide (and twice as high by default).
const width = 2.4;
const sun = { x: 0.45, y: 0.75, z: 0.5 };

/**
 * Smoke and fire rising around an obstacle, simulated on the GPU in a grid
 * of cells (`@fdw/engine-fluids`): a fire burns on a brazier, its hot smoke
 * rises and swirls around a ball that hangs above it. The arrows (or IJKL)
 * move the ball; F switches between a fire and a chimney that blows cold
 * smoke sideways; R clears the air. The orbit camera: the mouse dragged,
 * the wheel.
 */
export function createSmoke(options: SmokeOptions = {}): SceneFactory {
  return (backend, surface, context = {}) => {
    const renderer = new Renderer(backend);
    const smokeRenderer = new SmokeRenderer(renderer, {
      toneMapping: 'neutral',
    });
    const [nx, ny, nz] = options.resolution ?? [48, 96, 48];
    const cell = width / nx;
    const smoke = new SmokeGrid(backend, {
      resolution: [nx, ny, nz],
      cell,
      origin: { x: -width / 2, y: 0, z: (-nz * cell) / 2 },
      vorticity: 3,
      buoyancy: 2,
      cooling: 1.6,
      densityDecay: 0.05,
      extinction: 10,
    });
    const light = new DirectionalLight({
      direction: { x: -sun.x, y: -sun.y, z: -sun.z },
      diffuse: { x: 2.4, y: 2.25, z: 2 },
      ambient: { x: 0.35, y: 0.4, z: 0.5 },
    });
    smokeRenderer
      .setSun(smoke, light)
      .setLook(smoke, { albedo: [0.45, 0.45, 0.47], fireIntensity: 0.4 });

    // --- The fire, or the chimney.
    let fire = options.fire ?? true;
    let emitter: SmokeEmitter | undefined;
    const setEmitter = () => {
      if (emitter) {
        smoke.removeEmitter(emitter);
      }
      emitter = smoke.addEmitter(
        fire
          ? {
              x: 0,
              y: 0.3,
              z: 0,
              radius: 0.32,
              density: 4,
              temperature: 6,
              turbulence: 0.85,
            }
          : {
              x: -0.7,
              y: 0.6,
              z: 0,
              radius: 0.22,
              density: 4,
              temperature: 0.8,
              velocity: { x: 1.6, y: 1.2, z: 0 },
            },
      );
    };
    setEmitter();

    // --- The ball the smoke flows around, moved by the keys.
    const ball = { x: 0, y: 1.9, z: 0, radius: 0.35 };
    const bodies = new FluidBodies(backend);
    let ballVelocity = { x: 0, y: 0, z: 0 };

    // --- What is drawn: a floor, a brazier, the ball.
    const pbr = new GraphBuilder('smoke scene');
    pbr.surface({
      shadingModel: 'pbr',
      baseColor: pbr.uniform('color', BuiltinTypes.vec3f),
      roughness: 0.8,
    });
    const graph = pbr.build();
    const material = (color: number[]) =>
      new Material({ graph, values: { color } });
    const cube = createCube();
    const ballTransform = new Transform();
    const items: RenderItem[] = [
      {
        mesh: cube,
        material: material([0.22, 0.21, 0.2]),
        transform: new Transform({
          position: { x: 0, y: -0.05, z: 0 },
          scale: { x: 12, y: 0.1, z: 12 },
        }),
      },
      {
        mesh: cube,
        material: material([0.15, 0.13, 0.12]),
        transform: new Transform({
          position: { x: 0, y: 0.08, z: 0 },
          scale: { x: 0.7, y: 0.16, z: 0.7 },
        }),
      },
      {
        mesh: createSphere(32, 16),
        material: material([0.6, 0.62, 0.66]),
        transform: ballTransform,
      },
    ];

    // --- The camera.
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 50,
        aspect: 16 / 9,
        near: 0.05,
        far: 200,
      },
    });
    const input = new Input(context.input ?? new FakeInputSource());
    const actions = new ActionMap(input, {
      ...OrbitActions,
      ball: {
        type: 'vector',
        bindings: [
          {
            up: 'key:KeyI',
            down: 'key:KeyK',
            left: 'key:KeyJ',
            right: 'key:KeyL',
          },
          'gamepad:leftStick',
        ],
      },
      fire: { type: 'button', bindings: ['key:KeyF', 'gamepad:north'] },
      reset: { type: 'button', bindings: ['key:KeyR', 'gamepad:back'] },
    });
    const orbit = new OrbitOperator(camera, actions, {
      pivot: { x: 0, y: 1.9, z: 0 },
      distance: options.view?.distance ?? 5,
      yaw: options.view?.yaw ?? 0.35,
      pitch: options.view?.pitch ?? -0.12,
      minPitch: -1.3,
      maxPitch: 0.6,
      maxDistance: 20,
      moveSpeed: 0,
    });

    let last = 0;
    return {
      frame: (now) => {
        const dt = Math.min(now - last, 0.1);
        last = now;
        input.update();
        followAspect(camera, surface);
        if (actions.button('fire').pressed) {
          fire = !fire;
          setEmitter();
        }
        if (actions.button('reset').pressed) {
          smoke.reset();
        }
        // The ball: moved by the keys, swaying a little on its own.
        const move = actions.vector('ball');
        const speed = 1.2;
        const sway = 0.25 * Math.sin(now * 0.7);
        const next = {
          x: Math.min(Math.max(ball.x + move.x * speed * dt, -0.8), 0.8),
          y: Math.min(Math.max(ball.y + move.y * speed * dt, 0.9), 3.8),
        };
        ballVelocity = {
          x:
            dt > 0
              ? (next.x - ball.x) / dt + 0.25 * 0.7 * Math.cos(now * 0.7)
              : 0,
          y: dt > 0 ? (next.y - ball.y) / dt : 0,
          z: 0,
        };
        ball.x = next.x;
        ball.y = next.y;
        const body: FluidBody = {
          shape: { type: 'sphere', radius: ball.radius },
          position: { x: ball.x + sway, y: ball.y, z: ball.z },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          center: { x: ball.x + sway, y: ball.y, z: ball.z },
          velocity: ballVelocity,
          angularVelocity: { x: 0, y: 0, z: 0 },
        };
        bodies.clearShapes().addShape(body).update();
        ballTransform.position = body.position;
        ballTransform.scale = {
          x: ball.radius * 2,
          y: ball.radius * 2,
          z: ball.radius * 2,
        };
        orbit.update(dt);
        smoke.update(dt > 0 ? dt : 1 / 60, bodies);
        smokeRenderer.render({
          smoke,
          items,
          lights: [light],
          camera,
          surface,
          clearColor: { r: 0.42, g: 0.55, b: 0.72, a: 1 },
        });
        context.info?.(
          `smoke ${nx} × ${ny} × ${nz} · ${fire ? 'fire' : 'chimney'} · IJKL ball, F fire/chimney, R clear`,
        );
      },
      destroy: () => {
        input.dispose();
        bodies.destroy();
        smoke.destroy();
        smokeRenderer.destroy();
        renderer.destroy();
      },
    };
  };
}

/** The smoke and its fire (see {@link createSmoke}). */
export const createSmokeScene = () => createSmoke();
