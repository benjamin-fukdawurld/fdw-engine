import { Mesh, PointLight } from '@fdw/engine-core';
import type { Node, Scene } from '@fdw/engine-scene';
import { axisAngle } from '../geometry';
import { surfaceMaterial } from '../maze/world';
import { glowMaterial } from './arena';

/**
 * The layer of what the player carries: the weapon, the crosshair, the
 * sparks. Drawn, never hit: the shots search the other layers.
 */
export const ViewLayer = 1 << 1;

// The time between two shots, how long the flash of a shot lasts.
const period = 0.12;
const flashTime = 0.05;

/**
 * The weapon in the hand: a few cubes, children of the node of the camera,
 * that sway with the steps and kick back at each shot; a flash and a light
 * at the muzzle. It decides when it can fire; the game traces the shot.
 */
export class Weapon {
  readonly node: Node;
  private readonly _muzzle: Node;
  private readonly _crosshair: Node;
  private readonly _crosshairMaterials = [
    glowMaterial([1, 1, 1]),
    glowMaterial([1, 0.2, 0.1]),
  ];
  private _cooldown = 0;
  private _kick = 0;
  private _flash = 0;
  private _marker = 0;

  constructor(eye: Node, private readonly _cube: Mesh, sphere: Mesh) {
    const layers = ViewLayer;
    const metal = surfaceMaterial([0.12, 0.13, 0.15], 0.35);
    const grip = surfaceMaterial([0.25, 0.18, 0.12], 0.8);
    this.node = eye.add({ name: 'weapon', layers });
    const part = (
      position: { x?: number; y?: number; z?: number },
      scale: { x: number; y: number; z: number },
      material = metal
    ) =>
      this.node
        .add({ position, scale, layers })
        .setMesh(_cube, material, { castShadow: false });
    part({}, { x: 0.05, y: 0.065, z: 0.22 });
    part({ y: 0.012, z: -0.16 }, { x: 0.025, y: 0.025, z: 0.12 });
    part({ y: -0.06, z: 0.06 }, { x: 0.04, y: 0.08, z: 0.045 }, grip);
    part(
      { y: 0.04, z: 0.07 },
      { x: 0.012, y: 0.012, z: 0.012 },
      glowMaterial([0.2, 1, 0.9])
    );

    // The muzzle: a glowing ball and an orange light, shown at a shot.
    this._muzzle = this.node.add({
      name: 'muzzle',
      position: { y: 0.012, z: -0.24 },
      layers,
      visible: false,
    });
    this._muzzle
      .add({ scale: { x: 0.06, y: 0.06, z: 0.06 }, layers })
      .setMesh(sphere, glowMaterial([1, 0.8, 0.4]), { castShadow: false });
    this._muzzle.setLight(
      new PointLight({
        ambient: { x: 0, y: 0, z: 0 },
        diffuse: { x: 3, y: 1.8, z: 0.7 },
        specular: { x: 1, y: 0.7, z: 0.3 },
        quadraticAttenuation: 0.5,
      })
    );

    // The crosshair: a dot in front of the eye.
    this._crosshair = eye
      .add({
        name: 'crosshair',
        position: { z: -0.5 },
        scale: { x: 0.004, y: 0.004, z: 0.004 },
        layers,
      })
      .setMesh(_cube, this._crosshairMaterials[0], { castShadow: false });
    this.place(0);
  }

  /** Fires if ready: then the weapon kicks and flashes. */
  trigger(): boolean {
    if (this._cooldown > 0) {
      return false;
    }
    this._cooldown = period;
    this._kick = 1;
    this._flash = flashTime;
    return true;
  }

  /** A drone hit: the crosshair turns red, and grows, for a moment. */
  markHit(): void {
    this._marker = 0.12;
  }

  /** A frame: the timers, the sway of the steps, the recoil. */
  update(dt: number, walked: number): void {
    this._cooldown = Math.max(0, this._cooldown - dt);
    this._kick = Math.max(0, this._kick - dt * 8);
    this._flash = Math.max(0, this._flash - dt);
    this._muzzle.visible = this._flash > 0;
    const marked = this._marker > 0;
    this._marker = Math.max(0, this._marker - dt);
    if (marked !== this._marker > 0) {
      this._crosshair.setMesh(
        this._cube,
        this._crosshairMaterials[this._marker > 0 ? 1 : 0],
        { castShadow: false }
      );
    }
    const size = this._marker > 0 ? 0.008 : 0.004;
    this._crosshair.transform.scale = { x: size, y: size, z: size };
    this.place(walked);
  }

  // In the lower right of the view, swaying with the steps, kicked back.
  private place(walked: number): void {
    const step = walked * 2.2;
    this.node.transform.position = {
      x: 0.14 + Math.sin(step) * 0.008,
      y: -0.13 + Math.abs(Math.cos(step)) * 0.008 + this._kick * 0.01,
      z: -0.22 + this._kick * 0.05,
    };
    this.node.transform.rotation = axisAngle(1, 0, 0, this._kick * 0.15);
  }
}

/** Sparks where the shots hit: a few glowing cubes, reused. */
export class Sparks {
  private readonly _nodes: Node[] = [];
  private readonly _times: number[] = [];
  private _next = 0;

  constructor(scene: Scene, cube: Mesh, count = 12) {
    const material = glowMaterial([1, 0.85, 0.5]);
    for (let i = 0; i < count; i++) {
      this._nodes.push(
        scene.root
          .add({ name: 'spark', layers: ViewLayer, visible: false })
          .setMesh(cube, material, { castShadow: false })
      );
      this._times.push(0);
    }
  }

  /** A spark at a point: the oldest one moves there. */
  add(point: { x: number; y: number; z: number }): void {
    const i = this._next;
    this._next = (i + 1) % this._nodes.length;
    this._times[i] = 0.2;
    this._nodes[i].transform.position = point;
    this._nodes[i].visible = true;
  }

  /** A frame: the sparks shrink, then disappear. */
  update(dt: number): void {
    this._nodes.forEach((node, i) => {
      if (this._times[i] <= 0) {
        return;
      }
      this._times[i] -= dt;
      const size = Math.max(0, this._times[i]) * 0.6;
      node.transform.scale = { x: size, y: size, z: size };
      node.transform.rotation = axisAngle(0.6, 0.8, 0, this._times[i] * 20);
      node.visible = this._times[i] > 0;
    });
  }
}
