import type { Camera } from '@fdw/engine-core';
import {
  CameraTarget,
  FlyOperator,
  forwardOf,
  Vec3Like,
} from '@fdw/engine-camera';
import type { ActionMap } from '@fdw/engine-input';
import type { ComponentStore, Node, Scene } from '@fdw/engine-scene';
import { resolveCircle } from '../maze/collisions';

// The height of the eyes, the pull of gravity, the speed of a jump.
const eyeHeight = 1.6;
const gravity = 16;
const jumpSpeed = 5.5;

/**
 * The player: a camera node at the height of the eyes, walked and turned
 * by a FlyOperator in `walk` mode, kept out of the solid entities, falling
 * back after a jump. Its children (the weapon, the crosshair) follow it.
 */
export class FpsPlayer {
  /** The node of the camera: what the player sees from. */
  readonly eye: Node;
  readonly fly: FlyOperator;
  readonly radius = 0.4;
  health = 100;
  /** How far it walked: the weapon sways with it. */
  walked = 0;
  private _feet = 0;
  private _fall = 0;
  private _recoil = 0;
  private readonly _probe = { x: 0, y: 0, z: 0 };
  private readonly _forward = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly _scene: Scene,
    private readonly _solid: ComponentStore,
    camera: Camera,
    private readonly _actions: ActionMap,
    private readonly _half: number
  ) {
    this.eye = _scene.root.add({ name: 'eye' }).setCamera(camera);
    // The operator moves the node of the camera, and reads the aspect of
    // its projection: the pointer turns as much in both directions.
    const eye = this.eye;
    const target: CameraTarget = {
      get position() {
        return eye.transform.position;
      },
      set position(position: Vec3Like) {
        eye.transform.position = position;
      },
      get rotation() {
        return eye.transform.rotation;
      },
      set rotation(rotation) {
        eye.transform.rotation = rotation;
      },
      get projection() {
        return camera.projection;
      },
    };
    this.fly = new FlyOperator(target, _actions, {
      mode: 'walk',
      speed: 5,
      runFactor: 1.6,
      pointerSpeed: 2,
    });
  }

  /** Where the eyes are. */
  get position(): Readonly<Vec3Like> {
    return this.fly.position;
  }

  /** Where the player looks: a unit vector. */
  get forward(): Readonly<Vec3Like> {
    return forwardOf(this.fly.yaw, this.fly.pitch, this._forward);
  }

  /** On the ground, not in a jump. */
  get grounded(): boolean {
    return this._feet === 0;
  }

  /** Back at the start, healed. */
  reset(): void {
    Object.assign(this.fly.position, { x: 0, y: eyeHeight, z: 8 });
    this.fly.yaw = 0;
    this.fly.pitch = 0;
    this.health = 100;
    this._feet = 0;
    this._fall = 0;
    this._recoil = 0;
    this.fly.apply();
  }

  /** A frame: looking, walking, jumping, then out of the walls. */
  update(dt: number): void {
    const fly = this.fly;
    const { x, z } = fly.position;
    // The recoil of the shots wears off: the aim comes back down.
    const back = Math.min(this._recoil, dt * 0.25);
    fly.pitch -= back;
    this._recoil -= back;
    fly.update(dt);
    if (this._actions.button('jump').pressed && this.grounded) {
      this._fall = jumpSpeed;
    }
    this._fall -= gravity * dt;
    this._feet = Math.max(0, this._feet + this._fall * dt);
    if (this._feet === 0) {
      this._fall = 0;
    }
    // A circle at the height of the knees: the crates stop it too.
    const probe = this._probe;
    probe.x = fly.position.x;
    probe.y = this._feet + 0.5;
    probe.z = fly.position.z;
    resolveCircle(this._scene, this._solid, probe, this.radius);
    // The gates lead out: the player stays in.
    const limit = this._half - this.radius;
    fly.position.x = Math.min(Math.max(probe.x, -limit), limit);
    fly.position.z = Math.min(Math.max(probe.z, -limit), limit);
    fly.position.y = this._feet + eyeHeight;
    if (this.grounded) {
      this.walked += Math.hypot(fly.position.x - x, fly.position.z - z);
    }
    fly.apply();
  }

  /** The recoil of a shot: the view kicks up, then comes back. */
  kick(amount: number): void {
    const pitch = Math.min(this.fly.pitch + amount, this.fly.maxPitch);
    this._recoil += pitch - this.fly.pitch;
    this.fly.pitch = pitch;
    this.fly.apply();
  }
}
