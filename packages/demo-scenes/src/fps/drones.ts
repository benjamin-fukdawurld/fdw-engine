import type { Mesh } from '@fdw/engine-core';
import type { Component, ComponentStore, Node, Scene } from '@fdw/engine-scene';
import { resolveCircle } from '../maze/collisions';
import { multiplyQuat, rotationAround } from '../maze/quaternions';
import { surfaceMaterial } from '../maze/world';
import { glowMaterial } from './arena';

// A drone: where it is at the last step and at the one before (the frame
// draws it between both), its health, its timers, the node of its body.
const droneSchema = {
  x: 'f32',
  y: 'f32',
  z: 'f32',
  px: 'f32',
  py: 'f32',
  pz: 'f32',
  health: 'f32',
  // The time left before it can strike again.
  cooldown: 'f32',
  // The time left of the white flash of a hit.
  flash: 'f32',
  // Shot down: the time since; 0 while it flies.
  down: 'f32',
  // Its own phase, so that the drones do not bob together.
  phase: 'f32',
  body: 'ref',
} as const;

// How fast a drone flies, how close it strikes, how hard, how often.
const speed = 3.2;
const reach = 1.5;
const damage = 12;
const strikePeriod = 1.2;
// How long a drone shot down takes to fall and vanish.
const fallTime = 0.5;

/**
 * The enemies: drones flying at the player and striking it. Each one is an
 * entity with a `drone` component; the systems below go through them, at
 * the fixed step of the logic. The frame draws them between their last two
 * positions: smooth at any rate of the screen.
 */
export class Drones {
  readonly Drone: Component<typeof droneSchema>;
  private readonly _body = surfaceMaterial([0.2, 0.22, 0.26], 0.3);
  private readonly _flash = glowMaterial([1, 1, 1]);
  private readonly _eye = glowMaterial([1, 0.15, 0.05]);
  private readonly _wing = surfaceMaterial([0.6, 0.15, 0.1], 0.5);
  private readonly _probe = { x: 0, y: 0, z: 0 };
  private _time = 0;

  constructor(
    private readonly _scene: Scene,
    private readonly _solid: ComponentStore,
    private readonly _meshes: { cube: Mesh; sphere: Mesh }
  ) {
    this.Drone = _scene.world.defineComponent('drone', droneSchema);
  }

  /** The drones still flying. */
  get flying(): number {
    let count = 0;
    for (const entity of this.Drone.entities) {
      if (this.Drone.down[entity] === 0) {
        count++;
      }
    }
    return count;
  }

  /** A new drone at a point, ready to fly. */
  spawn(x: number, z: number, phase: number): void {
    const { cube, sphere } = this._meshes;
    const node = this._scene.root.add({ name: 'drone', position: { x, z } });
    const body = node
      .add({ name: 'body', scale: { x: 0.8, y: 0.6, z: 0.8 } })
      .setMesh(sphere, this._body);
    node
      .add({
        name: 'eye',
        position: { y: 0.05, z: -0.36 },
        scale: { x: 0.22, y: 0.22, z: 0.1 },
      })
      .setMesh(sphere, this._eye, { castShadow: false });
    for (const side of [-1, 1]) {
      node
        .add({
          name: 'wing',
          position: { x: side * 0.55 },
          scale: { x: 0.4, y: 0.06, z: 0.5 },
        })
        .setMesh(cube, this._wing);
    }
    const y = 1.5;
    node.attach(this.Drone, {
      x,
      y,
      z,
      px: x,
      py: y,
      pz: z,
      health: 3,
      phase,
      body,
    });
  }

  /** Removes every drone. */
  clear(): void {
    // Removing a node removes its entity from the store: copy first.
    for (const entity of [...this.Drone.entities]) {
      this._scene.node(entity).remove();
    }
  }

  /**
   * The drone a node belongs to, if any: the shots hit the parts (the
   * body, the eye, the wings), children of the node of the drone.
   */
  droneOf(entity: number): number | undefined {
    const parent = this._scene.node(entity).parent;
    return parent &&
      this.Drone.has(parent.entity) &&
      !this.Drone.down[parent.entity]
      ? parent.entity
      : undefined;
  }

  /** A shot: the drone flashes; returns true when it is shot down. */
  hit(entity: number): boolean {
    const { health, flash, down, body } = this.Drone;
    health[entity] -= 1;
    flash[entity] = 0.08;
    (body[entity] as Node).setMesh(this._meshes.sphere, this._flash);
    if (health[entity] > 0) {
      return false;
    }
    down[entity] = 1e-6;
    return true;
  }

  // --- Systems, at the fixed step -----------------------------------------------

  /**
   * Flies each drone towards the player, apart from the others, out of
   * the walls, bobbing.
   */
  steer(step: number, player: { x: number; z: number }): void {
    this._time += step;
    const { x, y, z, px, py, pz, down, phase } = this.Drone;
    const entities = this.Drone.entities;
    for (const e of entities) {
      px[e] = x[e];
      py[e] = y[e];
      pz[e] = z[e];
      if (down[e] > 0) {
        continue;
      }
      let dx = player.x - x[e];
      let dz = player.z - z[e];
      const distance = Math.hypot(dx, dz);
      // Close enough: it hovers and strikes.
      const pace = distance > reach * 0.8 ? speed / distance : 0;
      dx *= pace;
      dz *= pace;
      // Apart from the others: pushed away from those too close.
      for (const other of entities) {
        const ox = x[e] - x[other];
        const oz = z[e] - z[other];
        const d = Math.hypot(ox, oz);
        if (other !== e && d < 1.6 && d > 1e-4) {
          dx += (ox / d) * 2;
          dz += (oz / d) * 2;
        }
      }
      const probe = this._probe;
      probe.x = x[e] + dx * step;
      probe.y = 1.5;
      probe.z = z[e] + dz * step;
      resolveCircle(this._scene, this._solid, probe, 0.5);
      x[e] = probe.x;
      z[e] = probe.z;
      y[e] = 1.5 + Math.sin(this._time * 3 + phase[e]) * 0.2;
    }
  }

  /** The drones close to the player strike it: returns the damage. */
  strike(step: number, player: { x: number; y: number; z: number }): number {
    const { x, y, z, cooldown, down } = this.Drone;
    let total = 0;
    for (const e of this.Drone.entities) {
      cooldown[e] = Math.max(0, cooldown[e] - step);
      if (down[e] > 0 || cooldown[e] > 0) {
        continue;
      }
      const distance = Math.hypot(
        player.x - x[e],
        player.y - 0.4 - y[e],
        player.z - z[e]
      );
      if (distance < reach) {
        cooldown[e] = strikePeriod;
        total += damage;
      }
    }
    return total;
  }

  /** The flashes of the hits fade; the drones shot down fall, then vanish. */
  fade(step: number): void {
    const { y, flash, down, body } = this.Drone;
    for (const e of [...this.Drone.entities]) {
      if (flash[e] > 0) {
        flash[e] -= step;
        if (flash[e] <= 0) {
          (body[e] as Node).setMesh(this._meshes.sphere, this._body);
        }
      }
      if (down[e] > 0) {
        down[e] += step;
        y[e] = Math.max(0.3, y[e] - step * 8);
        if (down[e] >= fallTime) {
          this._scene.node(e).remove();
        }
      }
    }
  }

  // --- Once per frame ---------------------------------------------------------------

  /**
   * Writes the nodes between the last two steps (`alpha` from 0 to 1),
   * facing the player; a drone shot down shrinks and tumbles.
   */
  draw(alpha: number, player: { x: number; z: number }): void {
    const { x, y, z, px, py, pz, down } = this.Drone;
    for (const e of this.Drone.entities) {
      const node = this._scene.node(e);
      const cx = px[e] + (x[e] - px[e]) * alpha;
      const cz = pz[e] + (z[e] - pz[e]) * alpha;
      node.transform.position = {
        x: cx,
        y: py[e] + (y[e] - py[e]) * alpha,
        z: cz,
      };
      // Facing the player, rolling on its side when falling.
      const yaw = Math.atan2(-(player.x - cx), -(player.z - cz));
      node.transform.rotation = multiplyQuat(
        rotationAround('y', yaw),
        rotationAround('z', down[e] * 12)
      );
      const size = 1 - down[e] / fallTime;
      node.transform.scale = { x: size, y: size, z: size };
    }
  }
}
