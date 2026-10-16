import type { Node } from '@fdw/engine-scene';
import { multiplyQuat, rotationAround } from './quaternions';
import type { ActionMap } from '@fdw/engine-input';

/**
 * A camera following a target from above and behind, smoothly: the `turn`
 * action turns it around the target, `zoom` and `zoomStep` bring it closer
 * or further.
 */
export class FollowCamera {
  // Around the target (radians around y), and how far.
  yaw = 0;
  distance = 10;
  // Steep: a wall hides little behind it, the character stays in view.
  readonly pitch = -1.25;
  private readonly _position = { x: 0, y: 0, z: 0 };
  private _started = false;

  constructor(
    private readonly _node: Node,
    private readonly _actions: ActionMap,
  ) {}

  update(dt: number, target: { x: number; y: number; z: number }): void {
    const actions = this._actions;
    this.yaw += actions.axis('turn') * 1.8 * dt;
    // A notch of the wheel: 10 %; the pad held: twice as far per second.
    const zoom = actions.axis('zoomStep') * 0.1 + actions.axis('zoom') * dt;
    this.distance = Math.min(30, Math.max(4, this.distance * Math.exp(zoom)));
    // Where the camera should be: behind the target, up along the pitch.
    const back = Math.cos(this.pitch) * this.distance;
    const wanted = {
      x: target.x + Math.sin(this.yaw) * back,
      y: target.y - Math.sin(this.pitch) * this.distance,
      z: target.z + Math.cos(this.yaw) * back,
    };
    // Smoothly: a fraction of the way each frame, the same whatever the
    // frame rate.
    const follow = this._started ? 1 - Math.exp(-8 * dt) : 1;
    this._started = true;
    for (const axis of ['x', 'y', 'z'] as const) {
      this._position[axis] += (wanted[axis] - this._position[axis]) * follow;
    }
    this._node.transform.position = this._position;
    this._node.transform.rotation = multiplyQuat(
      rotationAround('y', this.yaw),
      rotationAround('x', this.pitch),
    );
  }
}
