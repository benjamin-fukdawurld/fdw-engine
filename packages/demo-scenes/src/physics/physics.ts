import type { IQuat, IVec3 } from '@fdw/engine-backend';
import { OrbitActions, OrbitOperator } from '@fdw/engine-camera';
import {
  Camera,
  DirectionalLight,
  Material,
  Mesh,
  Renderer,
} from '@fdw/engine-core';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import {
  ColliderDesc,
  PhysicsDebugView,
  PhysicsEngine,
  ScenePhysics,
  Shapes,
} from '@fdw/engine-physics';
import type { Node } from '@fdw/engine-scene';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import {
  axisAngle,
  createCapsule,
  createCube,
  createSphere,
} from '../geometry';
import { followAspect, SceneFactory } from '../scene';

type Color = [number, number, number];

// The bodies of the playground, rebuilt by a reset; the static ones stay.
const rainCount = 40;
const shotCount = 30;

/**
 * A physics playground, on any engine of @fdw/engine-physics: a pyramid of
 * boxes, a row of dominoes, a chain, a door on a hinge, a kinematic
 * sweeper, shapes raining down a ramp, a zone that lights up what enters
 * it. F (gamepad south) shoots a ball, Space (west) pushes what is at the
 * center of the view, B (north) shows the debug view, R (back) resets.
 * The orbit camera: the mouse dragged, the arrows, the right stick.
 */
export function createPhysicsScene(engine: PhysicsEngine): SceneFactory {
  return (backend, surface, context = {}) => {
    const scene = new Scene();
    const world = engine.createWorld();
    const physics = new ScenePhysics(scene, world);
    const debug = new PhysicsDebugView(scene, world);
    debug.enabled = false;

    const g = new GraphBuilder('physics playground');
    g.surface({
      shadingModel: 'pbr',
      baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
      roughness: 0.55,
    });
    const graph = g.build();
    const materials = new Map<string, Material>();
    const material = (color: Color) => {
      const key = color.join();
      let found = materials.get(key);
      if (!found) {
        found = new Material({ graph, values: { baseColor: color } });
        materials.set(key, found);
      }
      return found;
    };
    const cube = createCube();
    const sphere = createSphere(24, 12);
    const capsules = new Map<string, Mesh>();
    const capsule = (halfHeight: number, radius: number) => {
      const key = `${halfHeight},${radius}`;
      let found = capsules.get(key);
      if (!found) {
        found = createCapsule(halfHeight, radius);
        capsules.set(key, found);
      }
      return found;
    };

    // A node drawn by a mesh, with its body.
    const body = (
      type: 'static' | 'dynamic' | 'kinematic',
      at: { position: Partial<IVec3>; rotation?: IQuat },
      shape: ColliderDesc['shape'],
      color: Color,
      collider: Omit<ColliderDesc, 'shape'> = {},
      ccd = false,
    ): Node => {
      const node = scene.root.add({
        position: at.position,
        rotation: at.rotation,
        static: type === 'static',
      });
      if (shape.type === 'box') {
        const { x, y, z } = shape.halfExtents;
        node.transform.scale = { x: 2 * x, y: 2 * y, z: 2 * z };
        node.setMesh(cube, material(color));
      } else if (shape.type === 'sphere') {
        const d = 2 * shape.radius;
        node.transform.scale = { x: d, y: d, z: d };
        node.setMesh(sphere, material(color));
      } else if (shape.type === 'capsule') {
        node.setMesh(capsule(shape.halfHeight, shape.radius), material(color));
      }
      physics.add(node, {
        type,
        ccd,
        colliders: [{ shape, ...collider }],
      });
      return node;
    };

    // The static world: the ground, a ramp, the posts of the chain and of
    // the door, the zone.
    body(
      'static',
      { position: { y: -0.5 } },
      Shapes.box(16, 0.5, 16),
      [0.42, 0.44, 0.47],
    );
    body(
      'static',
      {
        position: { x: -9, y: 2.2, z: 2 },
        rotation: axisAngle(0, 0, 1, -0.38),
      },
      Shapes.box(4, 0.2, 2.5),
      [0.35, 0.38, 0.45],
    );
    const beam = body(
      'static',
      { position: { x: 7, y: 7, z: -6 } },
      Shapes.box(1.5, 0.2, 0.2),
      [0.3, 0.3, 0.33],
    );
    const post = body(
      'static',
      { position: { x: -4, y: 1.5, z: 6 } },
      Shapes.box(0.15, 1.5, 0.15),
      [0.3, 0.3, 0.33],
    );
    // The zone: a plate drawn on the ground, a sensor above it.
    scene.root
      .add({
        position: { x: 0, y: 0.01, z: 9 },
        scale: { x: 6, y: 0.02, z: 4 },
        static: true,
      })
      .setMesh(cube, material([0.6, 0.55, 0.2]));
    const zone = physics.world.createBody({
      type: 'static',
      position: { x: 0, y: 1, z: 9 },
      colliders: [{ shape: Shapes.box(3, 1, 2), sensor: true }],
    });

    // The sweeper: a kinematic bar turned by its node.
    const sweeper = body(
      'kinematic',
      { position: { x: 0, y: 0.35, z: 0 } },
      Shapes.box(4, 0.3, 0.2),
      [0.75, 0.35, 1],
    );

    // The zone lights up what is inside.
    const inside = new Map<number, number>();
    const meshes = new Map<number, Material>();
    // A node removed, forgotten by the zone: its entity will be reused.
    function discard(node: Node | undefined): void {
      if (node?.alive) {
        inside.delete(node.entity);
        meshes.delete(node.entity);
        node.remove();
      }
    }
    const light = material([1, 0.95, 0.4]);
    const enter = (node: Node, delta: number) => {
      const count = (inside.get(node.entity) ?? 0) + delta;
      const renderer = scene.MeshRenderer;
      if (!renderer.has(node.entity)) {
        return;
      }
      if (count > 0 && !meshes.has(node.entity)) {
        meshes.set(node.entity, renderer.material[node.entity] as Material);
        node.setMesh(renderer.mesh[node.entity] as Mesh, light);
      } else if (count <= 0 && meshes.has(node.entity)) {
        node.setMesh(
          renderer.mesh[node.entity] as Mesh,
          meshes.get(node.entity) as Material,
        );
        meshes.delete(node.entity);
      }
      inside.set(node.entity, Math.max(count, 0));
    };

    // What the reset rebuilds.
    let dynamic: Node[] = [];
    const rain: Node[] = [];
    const shots: Node[] = [];
    let rained = 0;
    let rainTime = 0;
    const palette: Color[] = [
      [0.9, 0.3, 0.2],
      [0.95, 0.7, 0.2],
      [0.3, 0.7, 0.35],
      [0.25, 0.5, 0.9],
      [0.7, 0.35, 0.8],
    ];

    const build = () => {
      for (const node of [...dynamic, ...rain, ...shots]) {
        discard(node);
      }
      dynamic = [];
      rain.length = 0;
      shots.length = 0;
      rained = 0;

      // A pyramid of 6 rows.
      const size = 0.3;
      for (let row = 0; row < 6; row++) {
        for (let i = 0; i < 6 - row; i++) {
          dynamic.push(
            body(
              'dynamic',
              {
                position: {
                  x: -3 + (i - (5 - row) / 2) * 2.05 * size,
                  y: size + row * 2 * size,
                  z: -4,
                },
              },
              Shapes.box(size),
              palette[(row + i) % palette.length],
            ),
          );
        }
      }
      // Dominoes in a row, the first one leaning.
      for (let i = 0; i < 16; i++) {
        dynamic.push(
          body(
            'dynamic',
            {
              position: { x: 5, y: 0.6, z: -1 + i * 0.55 },
              rotation:
                i === 0 ? axisAngle(1, 0, 0, 0.35) : { x: 0, y: 0, z: 0, w: 1 },
            },
            Shapes.box(0.3, 0.6, 0.06),
            [0.92, 0.9, 0.85],
          ),
        );
      }
      // A chain of 8 links from the end of the beam, held out level, a
      // ball at its end: links of half a meter along x, joined end to end.
      // Masses of the same order: a light chain under a heavy ball
      // stretches.
      let previous = physics.bodyOf(beam);
      for (let i = 0; i < 9; i++) {
        const last = i === 8;
        const link = last
          ? body(
              'dynamic',
              { position: { x: 13, y: 7, z: -6 } },
              Shapes.sphere(0.5),
              [0.25, 0.25, 0.28],
              { density: 4 },
            )
          : body(
              'dynamic',
              {
                position: { x: 8.75 + 0.5 * i, y: 7, z: -6 },
                // The capsule along x: its local +y toward -x.
                rotation: axisAngle(0, 0, 1, Math.PI / 2),
              },
              Shapes.capsule(0.15, 0.08),
              [0.6, 0.6, 0.62],
              { density: 300 },
            );
        const linkBody = physics.bodyOf(link);
        if (previous && linkBody) {
          world.createJoint({
            type: 'ball',
            bodyA: previous,
            bodyB: linkBody,
            anchorA: i === 0 ? { x: 1.5 } : { y: -0.25 },
            anchorB: last ? { x: -0.5 } : { y: 0.25 },
          });
        }
        dynamic.push(link);
        previous = linkBody;
      }
      // A door on a hinge, swinging a quarter turn each way.
      const door = body(
        'dynamic',
        { position: { x: -2.85, y: 1.5, z: 6 } },
        Shapes.box(1, 1.4, 0.08),
        [0.55, 0.35, 0.2],
      );
      const postBody = physics.bodyOf(post);
      const doorBody = physics.bodyOf(door);
      if (postBody && doorBody) {
        world.createJoint({
          type: 'hinge',
          bodyA: postBody,
          bodyB: doorBody,
          anchorA: { x: 0.15 },
          anchorB: { x: -1 },
          axis: { x: 0, y: 1, z: 0 },
          limits: [-Math.PI / 2, Math.PI / 2],
        });
      }
      dynamic.push(door);
    };
    build();

    // Shapes raining down the ramp.
    const drop = () => {
      const kind = rained % 3;
      const at = {
        position: {
          x: -11 + (rained % 4) * 0.4,
          y: 7,
          z: 1 + (rained % 5) * 0.4,
        },
        rotation: axisAngle(0.6, 0.8, 0, rained),
      };
      const color = palette[rained % palette.length];
      const node =
        kind === 0
          ? body('dynamic', at, Shapes.sphere(0.3), color, {
              material: { restitution: 0.4 },
            })
          : kind === 1
            ? body('dynamic', at, Shapes.capsule(0.25, 0.2), color)
            : body('dynamic', at, Shapes.box(0.25), color);
      rain.push(node);
      rained++;
      if (rain.length > rainCount) {
        discard(rain.shift());
      }
    };

    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 55,
        aspect: 16 / 9,
        near: 0.1,
        far: 200,
      },
    });
    scene.root.add({ rotation: axisAngle(1, 0.2, -0.3, -1) }).setLight(
      new DirectionalLight({
        castShadow: true,
        diffuse: { x: 1.3, y: 1.25, z: 1.15 },
        ambient: { x: 0.2, y: 0.22, z: 0.27 },
      }),
    );
    const renderer = new Renderer(backend, {
      output: { toneMapping: 'neutral', encoding: 'srgb' },
    });

    const input = new Input(context.input ?? new FakeInputSource());
    const actions = new ActionMap(input, {
      ...OrbitActions,
      shoot: { type: 'button', bindings: ['key:KeyF', 'gamepad:south'] },
      push: { type: 'button', bindings: ['key:Space', 'gamepad:west'] },
      debug: { type: 'button', bindings: ['key:KeyB', 'gamepad:north'] },
      reset: { type: 'button', bindings: ['key:KeyR', 'gamepad:back'] },
    });
    const orbit = new OrbitOperator(camera, actions, {
      pivot: { x: 0, y: 1.5, z: 1 },
      distance: 24,
      yaw: 0.45,
      pitch: -0.5,
    });
    const forward = (): IVec3 => ({
      x: -Math.sin(orbit.yaw) * Math.cos(orbit.pitch),
      y: Math.sin(orbit.pitch),
      z: -Math.cos(orbit.yaw) * Math.cos(orbit.pitch),
    });

    const scheduler = new Scheduler();
    let stepTime = 0;

    // begin: the input, the shots and pushes asked.
    scheduler.add(
      'input',
      () => {
        input.update();
        followAspect(camera, surface);
        if (actions.button('debug').pressed) {
          debug.enabled = !debug.enabled;
        }
        if (actions.button('reset').pressed) {
          build();
        }
        const { x, y, z } = camera.position;
        const origin = { x, y, z };
        const direction = forward();
        if (actions.button('shoot').pressed) {
          const ball = body(
            'dynamic',
            {
              position: {
                x: x + direction.x,
                y: y + direction.y,
                z: z + direction.z,
              },
            },
            Shapes.sphere(0.35),
            [0.9, 0.9, 0.95],
            { density: 4 },
            true,
          );
          const shot = physics.bodyOf(ball);
          if (shot) {
            shot.linearVelocity = {
              x: direction.x * 30,
              y: direction.y * 30,
              z: direction.z * 30,
            };
          }
          shots.push(ball);
          if (shots.length > shotCount) {
            discard(shots.shift());
          }
        }
        if (actions.button('push').pressed) {
          const hit = world.raycast(origin, direction, 100);
          debug.ray(origin, direction, 100, hit);
          if (hit?.body.type === 'dynamic') {
            const strength = 6 * hit.body.mass;
            hit.body.applyImpulse(
              {
                x: direction.x * strength,
                y: direction.y * strength + 2 * hit.body.mass,
                z: direction.z * strength,
              },
              hit.point,
            );
          }
        }
      },
      { phase: 'begin' },
    );

    // fixed: the sweeper turned, the rain, the simulation, the zone.
    scheduler.add(
      'sweep',
      () => {
        sweeper.transform.rotation = axisAngle(0, 1, 0, scheduler.time * 0.6);
      },
      { phase: 'fixed' },
    );
    scheduler.add(
      'rain',
      (step) => {
        rainTime += step;
        if (rainTime > 0.4) {
          rainTime = 0;
          drop();
        }
      },
      { phase: 'fixed' },
    );
    scheduler.add(
      'physics',
      (step) => {
        const start = performance.now();
        physics.step(step);
        stepTime = performance.now() - start;
        for (const event of physics.events) {
          if (!event.sensor) {
            continue;
          }
          const other = event.a.body === zone ? event.b : event.a;
          const node = physics.nodeOf(other);
          if (node) {
            enter(node, event.type === 'begin' ? 1 : -1);
          }
        }
        // Fallen off the ground.
        for (const list of [rain, shots]) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].transform.position.y < -20) {
              discard(list[i]);
              list.splice(i, 1);
            }
          }
        }
      },
      { phase: 'fixed', after: ['sweep', 'rain'] },
    );

    // update: the camera, the nodes between two steps, the debug lines.
    scheduler.add('camera', (dt) => orbit.update(dt));
    scheduler.add('sync', () => physics.sync(scheduler.alpha));
    scheduler.add('debug', (dt) => debug.update(dt), { after: ['sync'] });

    scheduler.add(
      'render',
      () => {
        renderer.render({
          source: scene,
          camera,
          surface,
          clearColor: { r: 0.62, g: 0.7, b: 0.8, a: 1 },
        });
      },
      { phase: 'render' },
    );
    scheduler.add(
      'status',
      () => {
        let bodies = 0;
        let sleeping = 0;
        for (const b of world.bodies) {
          if (b.type === 'dynamic') {
            bodies++;
            sleeping += b.sleeping ? 1 : 0;
          }
        }
        context.info?.(
          `${engine.name}: ${bodies} bodies, ${sleeping} asleep, step ${stepTime.toFixed(
            2,
          )} ms · F shoot, Space push, B debug${
            debug.enabled ? ' (on)' : ''
          }, R reset`,
        );
      },
      { phase: 'render', after: ['render'] },
    );

    let last = 0;
    return {
      frame: (time) => {
        scheduler.update(Math.min(time - last, 0.1));
        last = time;
      },
      destroy: () => {
        input.dispose();
        debug.destroy();
        physics.destroy();
        world.destroy();
        renderer.destroy();
      },
    };
  };
}
