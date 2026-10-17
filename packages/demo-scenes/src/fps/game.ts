import type { Camera } from '@fdw/engine-core';
import { Ray } from '@fdw/engine-geometry';
import type { ActionMap } from '@fdw/engine-input';
import type { Node, Scene } from '@fdw/engine-scene';
import type { Arena } from './arena';
import { Drones } from './drones';
import { FpsPlayer } from './player';
import type { FpsSoundEvents } from './sounds';
import { Sparks, ViewLayer, Weapon } from './weapon';

/** Where the game is: playing, or the player is down. */
export type FpsState = 'playing' | 'over';

// The pause between two waves, in seconds; the drones of a wave at most.
const wavePause = 2;
const maxDrones = 12;
// How far a shot goes.
const range = 100;

/**
 * The game: waves of drones coming in through the gates, a player shooting
 * them down. Its methods are the systems of the frame, called by the
 * scheduler of the scene (see createFpsScene).
 */
export class FpsGame {
  readonly player: FpsPlayer;
  readonly weapon: Weapon;
  readonly drones: Drones;
  readonly sparks: Sparks;
  state: FpsState = 'playing';
  wave = 0;
  score = 0;
  shots = 0;
  hits = 0;
  /** The gamepad rumbles at the shots and the blows. */
  rumble = true;
  /** The time left of the red of a blow, for the view. */
  hurt = 0;
  /** What hears the game: its sounds, when there is an audio engine. */
  sounds?: FpsSoundEvents;
  private _pause = 0;
  private readonly _ray = new Ray([0, 0, 0], [0, 0, -1]);

  constructor(
    private readonly _scene: Scene,
    private readonly _arena: Arena,
    camera: Camera,
    private readonly _actions: ActionMap,
    // The sounds, heard from the eye of the player.
    sounds?: (eye: Node) => FpsSoundEvents,
  ) {
    const { cube, sphere, Solid, half } = _arena;
    this.player = new FpsPlayer(_scene, Solid, camera, _actions, half);
    this.weapon = new Weapon(this.player.eye, cube, sphere);
    this.drones = new Drones(_scene, Solid, { cube, sphere });
    this.sparks = new Sparks(_scene, cube);
    this.sounds = sounds?.(this.player.eye);
    this.reset();
  }

  /** A new game: the player at the start, the first wave coming. */
  reset(): void {
    this.drones.clear();
    this.player.reset();
    this.state = 'playing';
    this.wave = 0;
    this.score = 0;
    this.shots = 0;
    this.hits = 0;
    this.hurt = 0;
    this.nextWave();
  }

  // --- At the fixed step --------------------------------------------------------

  /** The drones strike the player close to them; at 0 the game is over. */
  strikes(step: number): void {
    const damage = this.drones.strike(step, this.player.position);
    if (damage === 0) {
      return;
    }
    this.player.health = Math.max(0, this.player.health - damage);
    this.hurt = 0.25;
    this.sounds?.hurt();
    if (this.rumble) {
      this._actions.rumble(1, 0.5, 0.3);
    }
    if (this.player.health === 0) {
      this.state = 'over';
    }
  }

  /** Once a wave is down, a pause, then the next one, bigger. */
  waves(step: number): void {
    if (this.drones.Drone.entities.length > 0) {
      return;
    }
    this._pause += step;
    if (this._pause >= wavePause) {
      this.nextWave();
    }
  }

  // --- Once per frame -------------------------------------------------------------

  /**
   * The trigger held, the weapon ready: a ray from the eyes, along the view,
   * to the first thing it meets — the parts of a drone, or the arena,
   * where a spark flies. What the player carries is on its own layer: the
   * ray does not see it.
   */
  shoot(): void {
    if (!this._actions.button('fire').down || !this.weapon.trigger()) {
      return;
    }
    this.shots++;
    this.sounds?.shot();
    const { position, forward } = this.player;
    const ray = this._ray;
    ray.origin[0] = position.x;
    ray.origin[1] = position.y;
    ray.origin[2] = position.z;
    ray.direction[0] = forward.x;
    ray.direction[1] = forward.y;
    ray.direction[2] = forward.z;
    let hit: { entity: number; distance: number } | undefined;
    this._scene.raycastEntities(
      ray,
      (entity, distance) => {
        hit = { entity, distance };
        return false;
      },
      { layers: ~ViewLayer },
      range,
    );
    this.player.kick(0.012);
    let strength = 0.15;
    const drone = hit && this.drones.droneOf(hit.entity);
    if (drone !== undefined) {
      this.hits++;
      this.weapon.markHit();
      this.sounds?.hit();
      strength = 0.35;
      if (this.drones.hit(drone)) {
        this.score += 100 * this.wave;
        strength = 0.7;
        this.sounds?.down(this._scene.node(drone));
      }
    } else if (hit) {
      // A spark a little before the surface: not inside it.
      const at = ray.at(hit.distance - 0.05);
      this.sparks.add({ x: at[0], y: at[1], z: at[2] });
    }
    if (this.rumble) {
      this._actions.rumble(strength, strength * 0.6, 0.08);
    }
  }

  /** The line of the state of the game. */
  status(): string {
    const { health } = this.player;
    return [
      this.state === 'over' ? 'game over' : `wave ${this.wave}`,
      `${this.drones.flying} drones`,
      `health ${health}`,
      `score ${this.score}`,
      `hits ${this.hits}/${this.shots}`,
    ].join(' · ');
  }

  // Through the gates, one after the other: north (ahead of the player at
  // the start), south, west, east; the middle of the gate first, three abreast at most.
  private nextWave(): void {
    this._pause = 0;
    this.wave++;
    this.sounds?.wave(this.wave);
    const count = Math.min(1 + 2 * this.wave, maxDrones);
    const gates = this._arena.gates;
    for (let k = 0; k < count; k++) {
      const gate = gates[k % gates.length];
      const offset = [0, -1.1, 1.1][Math.floor(k / gates.length) % 3];
      const across = gate.x === 0;
      const drone = this.drones.spawn(
        gate.x + (across ? offset : 0),
        gate.z + (across ? 0 : offset),
        k * 1.7,
      );
      this.sounds?.spawned(drone);
    }
  }
}
