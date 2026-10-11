import type { Node } from '@fdw/engine-scene';
import type { Input } from './input';
import { multiplyQuat, rotationAround } from './quaternions';

/**
 * A camera flying above a level, looking down at an angle: WASD or the
 * arrows move it, Q and E turn it, the wheel changes its height, Shift
 * goes faster. It moves the node of the camera.
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
    private readonly _input: Input,
    private readonly _limits: { minHeight: number; maxHeight: number } = {
      minHeight: 4,
      maxHeight: 80,
    }
  ) {
    this.apply();
  }

  update(dt: number): void {
    const input = this._input;
    const speed = (input.isDown('shift') ? 3 : 1) * (5 + this.height) * dt;
    // Forward is -z, turned by the yaw.
    const forward = input.axis(['s', 'down'], ['w', 'up']);
    const right = input.axis(['a', 'left'], ['d', 'right']);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.x += (right * cos - forward * sin) * speed;
    this.z += (-right * sin - forward * cos) * speed;
    this.yaw += input.axis(['e'], ['q']) * 1.5 * dt;
    this.height = Math.min(
      this._limits.maxHeight,
      Math.max(
        this._limits.minHeight,
        this.height * Math.exp(input.takeWheel() * 0.001)
      )
    );
    this.apply();
  }

  private apply(): void {
    this._node.transform.position = { x: this.x, y: this.height, z: this.z };
    this._node.transform.rotation = multiplyQuat(
      rotationAround('y', this.yaw),
      rotationAround('x', this.pitch)
    );
  }
}
