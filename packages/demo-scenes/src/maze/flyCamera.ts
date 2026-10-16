import type { Node } from '@fdw/engine-scene';
import type { ActionMap } from '@fdw/engine-input';
import { multiplyQuat, rotationAround } from './quaternions';

/**
 * A camera flying above a level, looking down at an angle, driven by the
 * actions of the game (see mazeActions): `move` moves it, `turn` turns it,
 * `zoom` and `zoomStep` change its height, `run` goes faster. It moves the
 * node of the camera.
 */
export class FlyCamera {
  x = 0;
  z = 0;
  height = 20;
  yaw = 0;
  // Downwards, from the horizon.
  readonly pitch = -0.95;

  constructor(
    private readonly _node: Node,
    private readonly _actions: ActionMap,
    private readonly _limits: { minHeight: number; maxHeight: number } = {
      minHeight: 4,
      maxHeight: 80,
    },
  ) {
    this.apply();
  }

  update(dt: number): void {
    const actions = this._actions;
    const speed = (actions.button('run').down ? 3 : 1) * (5 + this.height) * dt;
    // Forward is -z, turned by the yaw.
    const { x: right, y: forward } = actions.vector('move');
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.x += (right * cos - forward * sin) * speed;
    this.z += (-right * sin - forward * cos) * speed;
    this.yaw += actions.axis('turn') * 1.5 * dt;
    // A notch of the wheel: 10 %; the pad held: twice as high per second.
    const zoom = actions.axis('zoomStep') * 0.1 + actions.axis('zoom') * dt;
    this.height = Math.min(
      this._limits.maxHeight,
      Math.max(this._limits.minHeight, this.height * Math.exp(zoom)),
    );
    this.apply();
  }

  private apply(): void {
    this._node.transform.position = { x: this.x, y: this.height, z: this.z };
    this._node.transform.rotation = multiplyQuat(
      rotationAround('y', this.yaw),
      rotationAround('x', this.pitch),
    );
  }
}
