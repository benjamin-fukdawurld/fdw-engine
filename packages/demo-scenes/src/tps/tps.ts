import type { GpuTexture, IVec3, RenderBackend } from '@fdw/engine-backend';
import type { BehaviorMode } from '@fdw/engine-behavior';
import { RenderBackendService } from '@fdw/engine-assets';
import { ThirdPersonOperator } from '@fdw/engine-camera';
import {
  Camera,
  DirectionalLight,
  Renderer,
  type FogOptions,
} from '@fdw/engine-core';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { OcclusionCulling } from '@fdw/engine-occlusion';
import { ScenePhysics, Shapes, type PhysicsEngine } from '@fdw/engine-physics';
import type { ResourceStore } from '@fdw/engine-resources';
import { Scene as SceneGraph, Scheduler } from '@fdw/engine-scene';
import { axisAngle } from '../geometry';
import { seededRandom } from '../maze/maze';
import { followAspect, type Scene, type SceneFactory } from '../scene';
import { loadTpsAssets, type TpsAssets } from './assets';
import { tpsControls } from './controls';
import { Enemies, EnemyKinds, TrunkGrid, type EnemyKind } from './enemies';
import { bakeRockTexture } from '../procedural/materials';
import { buildForest, type Forest, type ForestOptions } from './forest';
import { defineRock, loadTpsLevel } from './level';
import { Hero, type HeroIntent } from './hero';
import { TpsSounds } from './sounds';

/** A wave of enemies: how many of each kind. */
export interface Wave {
  readonly orcs: number;
  readonly demons?: number;
}

/** The waves of the demo: orcs, more orcs, the demon and its orcs. */
export const TpsWaves: readonly Wave[] = [
  { orcs: 3 },
  { orcs: 5 },
  { orcs: 3, demons: 1 },
];

export interface TpsOptions {
  /** The physics engine (Rapier: createRapierPhysics). */
  readonly physics: PhysicsEngine;
  /**
   * The store of the files, for a backend: with the glTF loader and an
   * image codec, the folder of the models mounted (see loadTpsAssets).
   */
  readonly resources: (backend: RenderBackend) => ResourceStore;
  /** The folder of the models in the store. Default 'forest/'. */
  readonly folder?: string;
  readonly forest?: ForestOptions;
  readonly waves?: readonly Wave[];
  /** Starts playing at once, without the menu (the tests, the screenshots). */
  readonly autoplay?: boolean;
  /**
   * How the graph of the enemies runs: compiled to JavaScript (default),
   * or interpreted, for its debugger.
   */
  readonly behavior?: BehaviorMode;
  /**
   * The level, a scene of the engine in the store (saveTpsLevel,
   * `forest/forest.scene.json`): loaded instead of building the forest.
   */
  readonly level?: string;
}

// The speeds of the pointer the menu offers, in radians per height of the
// surface.
const sensitivities = [
  { name: 'low', speed: 1.8 },
  { name: 'normal', speed: 3 },
  { name: 'high', speed: 4.5 },
];

const fog: FogOptions = {
  color: { r: 0.5, g: 0.58, b: 0.6 },
  density: 0.014,
  heightFalloff: 0.025,
};
const sky = { r: 0.6, g: 0.68, b: 0.72, a: 1 };

/** The scene of the game: resolves `ready` once its models are loaded and the forest built. */
export interface TpsScene extends Scene {
  readonly ready: Promise<void>;
}

/** What the game does with the assets loaded. */
interface Game {
  readonly forest: Forest;
  readonly physics: ScenePhysics;
  readonly hero: Hero;
  readonly enemies: Enemies;
  readonly sounds?: TpsSounds;
}

/**
 * A third-person game: a ranger with an estoc in a forest, waves of orcs,
 * then a demon. The forest of P1 to P3b (instanced firs with their levels
 * of detail, shadows in cascades, the terrain, the occlusion of the
 * trunks), the third-person camera and the character controller (P4,
 * P7b), the models and their animations (P5, P6), the sounds (P7); blows
 * as volumes tested while the animations strike, enemies decided by a
 * behavior graph (P9).
 */
export function createTpsScene(
  options: TpsOptions,
): (...args: Parameters<SceneFactory>) => TpsScene {
  const waves = options.waves ?? TpsWaves;
  return (backend, surface, context = {}) => {
    const scene = new SceneGraph();
    const input = new Input(context.input ?? new FakeInputSource());
    const { game: actions, menu } = tpsControls(input);
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 60,
        aspect: 16 / 9,
        near: 0.1,
        far: 500,
      },
    });
    const view = scene.root.add();
    view.setCamera(camera);
    const sun = new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.26, y: 0.3, z: 0.3 },
      diffuse: { x: 2.6, y: 2.4, z: 2.0 },
      shadow: { cascades: { count: 4, distance: 110 } },
    });
    scene.root.add({ rotation: axisAngle(0.5, 1, 0.3, -0.75) }).setLight(sun);
    const renderer = new Renderer(backend, {
      output: { toneMapping: 'neutral', encoding: 'srgb' },
      shadowAtlasSize: 4096,
    });
    const occlusion = new OcclusionCulling();
    const scheduler = new Scheduler();
    const operator = new ThirdPersonOperator(camera, actions, {
      distance: 4.2,
      height: 1.55,
      shoulder: 0.55,
      minPitch: -0.9,
      maxPitch: 0.45,
      pointerSpeed: sensitivities[1].speed,
    });
    const store = options.resources(backend);
    store.provideService(RenderBackendService, backend);
    const loading = loadTpsAssets(store, options.folder);
    let game: Game | undefined;
    let failed: string | undefined;
    let destroyed = false;

    // The state of the play: the wave, the pause between two.
    let wave = -1;
    let between = 2;
    let outcome: 'playing' | 'won' | 'lost' = 'playing';
    let hurtFlash = 0;
    const random = seededRandom(5);

    // The menu: open at the start, at a pause, at the end of a game.
    let started = false;
    let sensitivity = 1;
    let selected = 0;
    const reset = () => {
      if (!game) return;
      game.enemies.clear();
      game.hero.revive({ x: 0, y: game.forest.heightAt(0, 0), z: 0 });
      operator.focus = game.hero.actor.feet;
      operator.snap();
      wave = -1;
      between = 2;
      outcome = 'playing';
    };
    const play = () => {
      if (outcome !== 'playing') reset();
      started = true;
      menu.enabled = false;
      actions.enabled = true;
      scheduler.paused = false;
      input.lockPointer();
    };
    const pause = () => {
      actions.enabled = false;
      menu.enabled = true;
      scheduler.paused = true;
      selected = 0;
      input.lockPointer(false);
    };
    const audio = context.audio;
    const entries = [
      {
        label: () =>
          outcome !== 'playing' ? 'Play again' : started ? 'Resume' : 'Play',
        choose: play,
      },
      ...(audio
        ? [
            {
              label: () => `Sound: ${audio.master.muted ? 'off' : 'on'}`,
              choose: () => {
                audio.master.muted = !audio.master.muted;
              },
            },
          ]
        : []),
      {
        label: () => `Invert Y: ${operator.invertY ? 'on' : 'off'}`,
        choose: () => {
          operator.invertY = !operator.invertY;
        },
      },
      {
        label: () => `Sensitivity: ${sensitivities[sensitivity].name}`,
        choose: () => {
          sensitivity = (sensitivity + 1) % sensitivities.length;
          operator.pointerSpeed = sensitivities[sensitivity].speed;
        },
      },
    ];
    scheduler.paused = true;

    const trunksOf = new WeakMap<Forest, TrunkGrid>();

    // The buttons pressed since the last fixed step: a frame may run no
    // step, or several.
    const pressed = { jump: false, roll: false, attack: false, heavy: false };

    const start = async (assets: TpsAssets, rock: GpuTexture) => {
      const world = options.physics.createWorld();
      const physics = new ScenePhysics(scene, world);
      rockHandle = defineRock(store, backend, rock);
      const forest = options.level
        ? await loadTpsLevel(backend, scene, store, options.level, physics)
        : buildForest(backend, scene, physics, assets, rock, options.forest);
      if (destroyed) {
        physics.destroy();
        world.destroy();
        forest.destroy();
        return;
      }
      const trunks = new TrunkGrid(forest.trees);
      trunksOf.set(forest, trunks);
      const enemies = new Enemies(
        backend,
        scene,
        physics,
        { orc: assets.orc, demon: assets.demon },
        trunks,
        options.behavior ? { mode: options.behavior } : {},
      );
      const hero = new Hero(
        backend,
        scene,
        physics,
        assets.hero,
        { x: 0, y: forest.heightAt(0, 0), z: 0 },
        enemies.isEnemy,
      );
      const sounds = audio && new TpsSounds(scene, audio, view);
      if (sounds) {
        hero.events = sounds.hero;
        enemies.events = sounds.enemies;
        sounds.fight(false);
      }
      const heroEvents = hero.events;
      hero.events = {
        ...heroEvents,
        hurt: () => {
          hurtFlash = 0.25;
          heroEvents.hurt?.();
          actions.rumble(0.6, 0.3, 0.15);
        },
      };
      // The camera stops at the trunks, the ground and the enemies: never
      // inside an orc standing behind the hero.
      const body = hero.actor.character.body;
      operator.probe = (from, to, radius) => {
        const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
        const length = Math.hypot(d.x, d.y, d.z);
        if (length < 1e-4) return undefined;
        const hit = world.shapeCast(
          Shapes.sphere(radius),
          from,
          { x: 0, y: 0, z: 0, w: 1 },
          { x: d.x / length, y: d.y / length, z: d.z / length },
          length,
          { exclude: body },
        );
        return hit?.distance;
      };
      operator.focus = hero.actor.feet;
      operator.snap();
      game = { forest, physics, hero, enemies, sounds };
      installSystems(game);
      if (options.autoplay) play();
    };

    // Where an enemy comes from: out of sight around the hero, on the
    // ground of the play area, not in a trunk.
    const spawnPoint = (
      forest: Forest,
      trunks: TrunkGrid | undefined,
      around: IVec3,
    ): IVec3 => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const angle = random() * Math.PI * 2;
        const distance = 24 + random() * 12;
        let x = around.x + Math.cos(angle) * distance;
        let z = around.z + Math.sin(angle) * distance;
        const r = Math.hypot(x, z);
        const max = forest.playRadius - 6;
        if (r > max) {
          x *= max / r;
          z *= max / r;
        }
        let free = true;
        trunks?.near(x, z, 1.5, () => (free = false));
        if (free) return { x, y: forest.heightAt(x, z), z };
      }
      return {
        x: around.x + 20,
        y: forest.heightAt(around.x + 20, around.z),
        z: around.z,
      };
    };

    const installSystems = ({
      forest,
      physics,
      hero,
      enemies,
      sounds,
    }: Game) => {
      const trunks = trunksOf.get(forest);
      const target = {
        get position() {
          return hero.actor.body.worldPosition;
        },
        get alive() {
          return hero.alive;
        },
        get colliders() {
          return hero.colliders;
        },
        hurt: (damage: number, from: IVec3) => hero.hurt(damage, from),
      };
      // The enemy nearest in front of a direction, within reach of a blow.
      const aimFrom = (direction: { x: number; z: number }) => {
        const p = hero.actor.body.worldPosition;
        let best: { x: number; z: number } | undefined;
        let bestScore = Infinity;
        for (const entity of enemies.entities) {
          const agent = enemies.agent(entity);
          if (!agent || enemies.state(entity) === 'dead') continue;
          const q = agent.actor.body.worldPosition;
          const to = { x: q.x - p.x, z: q.z - p.z };
          const d = Math.hypot(to.x, to.z);
          if (d > 4.5 || d < 1e-3) continue;
          const facing = (to.x * direction.x + to.z * direction.z) / d;
          if (facing < 0.2) continue;
          const score = d * (2 - facing);
          if (score < bestScore) {
            bestScore = score;
            best = to;
          }
        }
        return best ?? direction;
      };

      // fixed: the hero, its blows; the enemies decide, move, strike; the
      // physics; the waves.
      scheduler.add(
        'hero',
        (step) => {
          const move = actions.vector('move', { x: 0, y: 0 });
          const forward = operator.forward;
          const right = operator.right;
          const world = {
            x: forward.x * move.y + right.x * move.x,
            z: forward.z * move.y + right.z * move.x,
          };
          const length = Math.hypot(world.x, world.z);
          if (length > 1) {
            world.x /= length;
            world.z /= length;
          }
          const intent: HeroIntent = {
            move: world,
            sprint: actions.button('sprint').down,
            jump: pressed.jump,
            roll: pressed.roll,
            attack: pressed.attack,
            heavy: pressed.heavy,
            block: actions.button('block').down,
            aim: aimFrom(length > 0.2 ? world : forward),
          };
          pressed.jump = pressed.roll = pressed.attack = pressed.heavy = false;
          for (const strike of hero.step(step, intent)) {
            const enemy = enemies.enemyOf(strike.collider);
            if (enemy !== undefined) {
              enemies.hit(enemy, strike.damage);
              actions.rumble(0.3, 0.6, 0.08);
            }
          }
          if (!hero.alive && outcome === 'playing') {
            outcome = 'lost';
          }
        },
        { phase: 'fixed' },
      );
      // The graph of the enemies is a system: it decides, moves and
      // strikes for each enemy.
      enemies.target = target;
      enemies.behavior.install(scheduler, {
        name: 'enemies',
        after: ['hero'],
      });
      physics.install(scheduler, { after: ['enemies'] });
      scheduler.add(
        'waves',
        (step) => {
          if (outcome !== 'playing' || enemies.alive > 0) {
            sounds?.fight(enemies.alive > 0 && outcome === 'playing');
            return;
          }
          sounds?.fight(false);
          between -= step;
          if (between > 0) return;
          wave++;
          if (wave >= waves.length) {
            outcome = 'won';
            return;
          }
          between = 4;
          sounds?.wave();
          const { orcs, demons = 0 } = waves[wave];
          const around = hero.actor.body.worldPosition;
          const spawn = (kind: EnemyKind) =>
            enemies.spawn(kind, spawnPoint(forest, trunks, around), around);
          for (let i = 0; i < demons; i++) spawn(EnemyKinds.demon);
          for (let i = 0; i < orcs; i++) spawn(EnemyKinds.orc);
        },
        { phase: 'fixed', after: ['physics'] },
      );

      // update: the characters drawn between two steps, animated; the
      // camera follows the hero as drawn.
      scheduler.add(
        'animate',
        (dt) => {
          hero.animate(dt);
          enemies.animate(dt);
        },
        { after: ['physics:sync'] },
      );
      scheduler.add(
        'camera',
        (dt) => {
          operator.focus = hero.actor.feet;
          operator.update(dt);
          view.transform.position = camera.position;
          view.transform.rotation = camera.rotation;
          hurtFlash = Math.max(0, hurtFlash - dt);
        },
        { after: ['animate'] },
      );
      forest.lods.install(scheduler, camera, { before: ['render'] });
      if (sounds) {
        scheduler.add('audio', () => sounds.update(), { phase: 'render' });
      }
    };

    // begin: the events since the previous frame; the menu, the pause.
    scheduler.add(
      'input',
      () => {
        input.update();
        followAspect(camera, surface);
        if (menu.active) {
          const count = entries.length;
          if (menu.button('up').pressed)
            selected = (selected + count - 1) % count;
          if (menu.button('down').pressed) selected = (selected + 1) % count;
          if (menu.button('confirm').pressed && game)
            entries[selected].choose();
        } else if (actions.active) {
          if (
            actions.button('pause').pressed ||
            actions.button('locked').released
          ) {
            pause();
          } else if (!input.pointer.locked && input.pointer.pressed(0)) {
            // Unlocked, a click locks the pointer again.
            input.lockPointer();
          } else {
            pressed.jump ||= actions.button('jump').pressed;
            pressed.roll ||= actions.button('roll').pressed;
            pressed.attack ||= actions.button('attack').pressed;
            pressed.heavy ||= actions.button('heavy').pressed;
          }
        }
      },
      { phase: 'begin' },
    );
    // The end of a game opens the menu.
    scheduler.add(
      'outcome',
      () => {
        if (outcome !== 'playing' && actions.enabled && game) {
          const { hero } = game;
          // The fall of the hero, or the last enemy, seen first.
          if (outcome === 'won' || hero.time > 2.5) pause();
        }
      },
      { phase: 'begin', after: ['input'] },
    );

    // render: the view, dimmed under the menu, reddened at a blow; the state.
    scheduler.add(
      'render',
      () => {
        if (game) {
          const { forest, hero, enemies } = game;
          forest.terrain.surface.update(camera, surface);
          renderer.render({
            source: scene,
            items: [forest.terrain.surface],
            camera,
            surface,
            fog,
            occlusion,
            exposure: menu.enabled ? 0.4 : 1 - hurtFlash,
            clearColor: sky,
            prepare: (graph) => {
              hero.actor.addPass(graph);
              enemies.addPasses(graph);
            },
          });
        } else {
          renderer.render({ items: [], camera, surface, clearColor: sky });
        }
      },
      { phase: 'render' },
    );
    scheduler.add(
      'status',
      () => {
        context.info?.(status());
      },
      { phase: 'render', after: ['render'] },
    );
    const status = () => {
      if (failed) return `loading failed: ${failed}`;
      if (!game) return `loading ${Math.round(loading.progress() * 100)} %`;
      const { hero, enemies } = game;
      const state =
        outcome === 'won'
          ? 'The forest is safe'
          : outcome === 'lost'
            ? 'Fallen'
            : wave < 0
              ? 'Get ready'
              : `Wave ${wave + 1}/${waves.length} · enemies ${enemies.alive}`;
      const health = `health ${Math.ceil(hero.health)}`;
      if (menu.enabled) {
        return `${state} · ${health} · ${entries
          .map(({ label }, i) => (i === selected ? `[${label()}]` : label()))
          .join(' · ')}`;
      }
      return `${state} · ${health} · ${
        input.pointer.locked
          ? 'LMB: strike · RMB: heavy · C: roll · F: parry · Space: jump · Shift: sprint · P: menu'
          : 'click to play'
      }`;
    };

    // The rock of the slopes, baked from noises while the models load.
    const baking = bakeRockTexture(renderer);
    let rockHandle: { release(): void } | undefined;
    const ready = Promise.all([loading.ready, baking])
      .then(([assets, rock]) => (destroyed ? undefined : start(assets, rock)))
      .catch((error: unknown) => {
        failed = error instanceof Error ? error.message : String(error);
      });

    let last = 0;
    return {
      ready,
      frame: (time) => {
        store.update();
        scheduler.update(Math.min(time - last, 0.1));
        last = time;
      },
      destroy: () => {
        destroyed = true;
        if (game) {
          game.sounds?.destroy();
          game.enemies.clear();
          game.hero.destroy();
          game.physics.destroy();
          game.physics.world.destroy();
          game.forest.destroy();
        }
        loading.release();
        // Defined in the store, the rock is destroyed with its handle.
        if (rockHandle) rockHandle.release();
        else void baking.then((rock) => rock.destroy());
        input.dispose();
        renderer.destroy();
      },
    };
  };
}
