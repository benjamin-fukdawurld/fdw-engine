import { Material, Mesh } from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { Component, ComponentStore, Node, Scene } from '@fdw/engine-scene';
import type { Exploration } from './exploration';
import type { Flashlight } from './flashlight';
import type { Level } from './level';
import { seededRandom } from './maze';
import { distancesFrom, nextStep, openNeighbors } from './paths';
import type { Player } from './player';
import { multiplyQuat, rotationAround } from './quaternions';
import { clearLine, inCone } from './sight';
import { surfaceMaterial } from './world';

/** What an enemy does. */
export const EnemyState = { Wander: 0, Chase: 1, Dazzled: 2 } as const;

/** Where the game is. */
export type GameState = 'playing' | 'won' | 'lost';

export interface GameOptions {
  readonly gems?: number;
  readonly enemies?: number;
  readonly seed?: number;
}

// The components of the game.
const gemSchema = { cell: 'i32' } as const;
const enemySchema = {
  state: 'u8',
  // Walking from the center of a cell to the center of the next.
  from: 'i32',
  to: 'i32',
  previous: 'i32',
  progress: 'f32',
  // Dazzled: the time left; chasing: the time it still remembers.
  timer: 'f32',
  // Where it last saw the player.
  seen: 'i32',
  // The nodes of its eyes.
  eyes: 'ref',
} as const;

// A material without lighting: seen in the dark, and always drawn.
function glowMaterial(color: [number, number, number]): Material {
  const g = new GraphBuilder('glow');
  g.surface({ baseColor: g.uniform('color', BuiltinTypes.vec3f) });
  return new Material({ graph: g.build(), values: { color } });
}

// The speeds of the enemies, in cells per second.
const wanderSpeed = 0.75;
const chaseSpeed = 1.6;
// How far an enemy sees the player, with the flashlight off and on.
const sightInDark = 4;
const sightOfLight = 14;
// How far the beam dazzles, and how long.
const dazzleReach = 9;
const dazzleTime = 2;
// How long a chasing enemy remembers where it saw the player.
const memory = 4;
// The logic of sight runs ten times per second, not at every step.
const sightPeriod = 0.1;

/**
 * The game: gems to collect, an exit opening once they all are, enemies
 * wandering the maze and chasing the player when they see it. Gems and
 * enemies are entities with components of the game; the update runs
 * systems over them — functions going through the entities of a
 * component, and reading and writing its columns.
 */
export class MazeGame {
  /** A gem, in a cell. */
  readonly Gem: Component<typeof gemSchema>;
  /** An enemy: what it does, the cells it walks between, its timers. */
  readonly Enemy: Component<typeof enemySchema>;
  state: GameState = 'playing';
  collected = 0;
  total = 0;
  /** The cell of the exit: the farthest from the start. */
  readonly exitCell: number;

  private readonly _random: () => number;
  private readonly _start: number;
  private readonly _fromStart: Int32Array;
  private readonly _exit: Node;
  private readonly _gemMaterial = surfaceMaterial([0.2, 0.85, 1], 0.15);
  private readonly _bodyMaterial = surfaceMaterial([0.3, 0.22, 0.35], 0.6);
  private readonly _eyes = glowMaterial([1, 0.12, 0.05]);
  private readonly _dazzledEyes = glowMaterial([0.9, 0.9, 1]);
  private readonly _locked = glowMaterial([0.6, 0.08, 0.05]);
  private readonly _open = glowMaterial([0.1, 0.9, 0.3]);
  private _sightTime = 0;
  private _time = 0;

  constructor(
    private readonly _scene: Scene,
    private readonly _level: Level,
    private readonly _solid: ComponentStore,
    private readonly _player: Player,
    private readonly _flashlight: Flashlight,
    private readonly _exploration: Exploration,
    private readonly _meshes: { cube: Mesh; sphere: Mesh },
    private readonly _options: GameOptions = {},
  ) {
    const { world } = _scene;
    this.Gem = world.defineComponent('gem', gemSchema);
    this.Enemy = world.defineComponent('enemy', enemySchema);
    this._random = seededRandom(_options.seed ?? 11);
    const { maze } = _level;
    this._start = 0;
    this._fromStart = distancesFrom(maze, this._start);
    let exit = 0;
    this._fromStart.forEach((distance, cell) => {
      if (distance > this._fromStart[exit]) {
        exit = cell;
      }
    });
    this.exitCell = exit;
    // The exit: a pad on the floor, glowing red, then green.
    const center = this.centerOf(exit);
    this._exit = _scene.root
      .add({
        name: 'exit',
        position: { x: center.x, y: 0.03, z: center.z },
        scale: { x: 1.6, y: 0.05, z: 1.6 },
      })
      .setMesh(_meshes.cube, this._locked, { castShadow: false });
    this.reset();
  }

  /** A new game: gems and enemies placed again, the player at the start. */
  reset(): void {
    for (const store of [this.Gem, this.Enemy]) {
      // Removing a node removes the entity from the store: copy first.
      for (const entity of [...store.entities]) {
        this._scene.node(entity).remove();
      }
    }
    const { maze } = this._level;
    const far = (min: number) =>
      [...this._fromStart.keys()].filter(
        (cell) => this._fromStart[cell] >= min && cell !== this.exitCell,
      );
    // Gems in dead ends, away from the start.
    const deadEnds = far(12).filter(
      (cell) => openNeighbors(maze, cell).length === 1,
    );
    this.total = Math.min(this._options.gems ?? 8, deadEnds.length);
    for (const cell of this.pick(deadEnds, this.total)) {
      this.addGem(cell);
    }
    for (const cell of this.pick(far(20), this._options.enemies ?? 4)) {
      this.addEnemy(cell);
    }
    this.collected = 0;
    this.state = 'playing';
    this._exit.setMesh(this._meshes.cube, this._locked, { castShadow: false });
    const start = this.centerOf(this._start);
    this._player.position.x = start.x;
    this._player.position.z = start.z;
    this._player.heading = 0;
    this._exploration.reset();
  }

  /** One step of the game: the systems, in order. */
  update(step: number): void {
    if (this.state !== 'playing') {
      return;
    }
    this._time += step;
    this._sightTime += step;
    if (this._sightTime >= sightPeriod) {
      this.sight(this._sightTime);
      this._sightTime = 0;
    }
    this.walk(step);
    this.spin();
    this.collect();
    this.catchPlayer();
    this.escape();
  }

  /** The cells of the gems left, for the map. */
  gemCells(): number[] {
    return [...this.Gem.entities].map((entity) => this.Gem.cell[entity]);
  }

  // --- Systems ----------------------------------------------------------------

  // What the enemies see: the beam dazzles them; the player, seen, is
  // chased; out of sight, it is forgotten after a while.
  private sight(elapsed: number): void {
    const { state, timer, seen } = this.Enemy;
    // The beam where the node of the flashlight is now.
    this._scene.flush();
    const beam = this._flashlight.on ? this._flashlight.beam : undefined;
    const player = this._player.position;
    const eye = { x: 0, y: 0.6, z: 0 };
    const target = { x: player.x, y: 0.6, z: player.z };
    const range = beam ? sightOfLight : sightInDark;
    for (const entity of this.Enemy.entities) {
      if (state[entity] === EnemyState.Dazzled) {
        continue;
      }
      const position = this._scene.node(entity).transform.position;
      eye.x = position.x;
      eye.z = position.z;
      if (
        beam &&
        inCone(beam, eye, dazzleReach) &&
        clearLine(this._scene, this._solid, beam.position, eye)
      ) {
        this.setEnemyState(entity, EnemyState.Dazzled);
        timer[entity] = dazzleTime;
        continue;
      }
      const distance = Math.hypot(player.x - eye.x, player.z - eye.z);
      if (
        distance < range &&
        clearLine(this._scene, this._solid, eye, target)
      ) {
        state[entity] = EnemyState.Chase;
        seen[entity] = this._exploration.cellAt(player.x, player.z);
        timer[entity] = memory;
      } else if (state[entity] === EnemyState.Chase) {
        timer[entity] -= elapsed;
        if (timer[entity] <= 0) {
          state[entity] = EnemyState.Wander;
        }
      }
    }
  }

  // The enemies walk from cell to cell: at random, or towards where they
  // saw the player. Dazzled, they stand still.
  private walk(step: number): void {
    const { maze } = this._level;
    const { state, from, to, previous, progress, timer, seen } = this.Enemy;
    for (const entity of this.Enemy.entities) {
      if (state[entity] === EnemyState.Dazzled) {
        timer[entity] -= step;
        if (timer[entity] <= 0) {
          this.setEnemyState(entity, EnemyState.Wander);
        }
        continue;
      }
      const chasing = state[entity] === EnemyState.Chase;
      progress[entity] += (chasing ? chaseSpeed : wanderSpeed) * step;
      if (progress[entity] >= 1) {
        // Arrived: choose the next cell.
        previous[entity] = from[entity];
        from[entity] = to[entity];
        progress[entity] = 0;
        to[entity] = chasing
          ? nextStep(maze, from[entity], seen[entity])
          : this.wanderFrom(from[entity], previous[entity]);
      }
      const a = this.centerOf(from[entity]);
      const b = this.centerOf(to[entity]);
      const t = progress[entity];
      const node = this._scene.node(entity);
      node.transform.position = {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
      };
      if (to[entity] !== from[entity]) {
        // Facing where it goes (-z when the angle is 0).
        const heading = Math.atan2(-(b.x - a.x), -(b.z - a.z));
        node.transform.rotation = rotationAround('y', heading);
      }
    }
  }

  // The gems turn on themselves, tilted: they catch the light.
  private spin(): void {
    const tilt = multiplyQuat(rotationAround('x', Math.PI / 4), {
      x: 0,
      y: 0,
      z: Math.sin(Math.PI / 8),
      w: Math.cos(Math.PI / 8),
    });
    const rotation = multiplyQuat(rotationAround('y', this._time * 1.5), tilt);
    for (const entity of this.Gem.entities) {
      this._scene.node(entity).transform.rotation = rotation;
    }
  }

  // The gems the player touches.
  private collect(): void {
    const player = this._player.position;
    for (const entity of [...this.Gem.entities]) {
      const center = this.centerOf(this.Gem.cell[entity]);
      if (Math.hypot(player.x - center.x, player.z - center.z) < 0.8) {
        this._scene.node(entity).remove();
        this.collected++;
        if (this.collected === this.total) {
          this._exit.setMesh(this._meshes.cube, this._open, {
            castShadow: false,
          });
        }
      }
    }
  }

  // An enemy touching the player, unless dazzled.
  private catchPlayer(): void {
    const player = this._player.position;
    for (const entity of this.Enemy.entities) {
      if (this.Enemy.state[entity] === EnemyState.Dazzled) {
        continue;
      }
      const position = this._scene.node(entity).transform.position;
      if (Math.hypot(player.x - position.x, player.z - position.z) < 1) {
        this.state = 'lost';
      }
    }
  }

  // The player on the open exit.
  private escape(): void {
    const player = this._player.position;
    if (
      this.collected === this.total &&
      this._exploration.cellAt(player.x, player.z) === this.exitCell
    ) {
      this.state = 'won';
    }
  }

  // --- Entities -----------------------------------------------------------------

  private addGem(cell: number): void {
    const center = this.centerOf(cell);
    this._scene.root
      .add({
        name: 'gem',
        position: { x: center.x, y: 0.6, z: center.z },
        scale: { x: 0.35, y: 0.35, z: 0.35 },
      })
      .setMesh(this._meshes.cube, this._gemMaterial)
      .attach(this.Gem, { cell });
  }

  private addEnemy(cell: number): void {
    const center = this.centerOf(cell);
    const node = this._scene.root.add({
      name: 'enemy',
      position: { x: center.x, z: center.z },
    });
    node
      .add({
        name: 'body',
        position: { y: 0.5 },
        scale: { x: 0.75, y: 1, z: 0.75 },
      })
      .setMesh(this._meshes.sphere, this._bodyMaterial);
    // Two eyes, glowing: what the player sees of it in the dark.
    const eyes = [-0.14, 0.14].map((x) =>
      node
        .add({
          name: 'eye',
          position: { x, y: 0.75, z: -0.33 },
          scale: { x: 0.1, y: 0.1, z: 0.1 },
        })
        .setMesh(this._meshes.sphere, this._eyes, { castShadow: false }),
    );
    node.attach(this.Enemy, {
      state: EnemyState.Wander,
      from: cell,
      to: this.wanderFrom(cell, -1),
      previous: -1,
      progress: 0,
      timer: 0,
      seen: -1,
      eyes,
    });
  }

  private setEnemyState(entity: number, state: number): void {
    this.Enemy.state[entity] = state;
    const eyes = this.Enemy.eyes[entity] as Node[];
    const material =
      state === EnemyState.Dazzled ? this._dazzledEyes : this._eyes;
    for (const eye of eyes) {
      eye.setMesh(this._meshes.sphere, material, { castShadow: false });
    }
  }

  // A random open neighbor, not the one it comes from unless in a dead end.
  private wanderFrom(cell: number, previous: number): number {
    const neighbors = openNeighbors(this._level.maze, cell);
    const ahead = neighbors.filter((next) => next !== previous);
    const choices = ahead.length > 0 ? ahead : neighbors;
    return choices[Math.floor(this._random() * choices.length)] ?? cell;
  }

  private pick(cells: number[], count: number): number[] {
    const left = [...cells];
    const picked: number[] = [];
    while (picked.length < count && left.length > 0) {
      picked.push(left.splice(Math.floor(this._random() * left.length), 1)[0]);
    }
    return picked;
  }

  private centerOf(cell: number): { x: number; z: number } {
    const { width } = this._level.maze;
    return this._level.cellCenter(cell % width, Math.floor(cell / width));
  }
}
