import type { Material, Mesh } from '@fdw/engine-core';
import type { ComponentStore, Node, Scene } from '@fdw/engine-scene';
import { resolveCircle } from './collisions';
import type { Input } from './input';

/** The character: a node moved by the keyboard, colliding with the walls. */
export class Player {
  /** The node of the character: it moves and turns; its children follow. */
  readonly node: Node;
  // Where the character is and where it faces (radians around y; 0: -z).
  readonly position: { x: number; y: number; z: number };
  heading = 0;
  readonly radius = 0.35;
  readonly speed = 4;

  constructor(
    private readonly _scene: Scene,
    private readonly _solid: ComponentStore,
    start: { x: number; z: number },
    { sphere, cube, body }: { sphere: Mesh; cube: Mesh; body: Material }
  ) {
    this.position = { x: start.x, y: 0, z: start.z };
    this.node = _scene.root.add({ name: 'player', position: this.position });
    // A body, and a nose showing where it faces: children of the node.
    this.node
      .add({
        name: 'body',
        position: { y: 0.4 },
        scale: { x: 0.7, y: 0.8, z: 0.7 },
      })
      .setMesh(sphere, body);
    this.node
      .add({
        name: 'nose',
        position: { y: 0.55, z: -0.35 },
        scale: { x: 0.15, y: 0.15, z: 0.25 },
      })
      .setMesh(cube, body);
  }

  /**
   * Moves the character along the keys, relative to the direction the
   * camera looks at (`cameraYaw`), then out of the walls.
   */
  update(dt: number, input: Input, cameraYaw: number): void {
    const forward = input.axis(['s', 'down'], ['w', 'up']);
    const right = input.axis(['a', 'left'], ['d', 'right']);
    if (forward !== 0 || right !== 0) {
      // The keys in the frame of the camera, then in the world.
      const length = Math.hypot(forward, right);
      const sin = Math.sin(cameraYaw);
      const cos = Math.cos(cameraYaw);
      const dx = (right * cos - forward * sin) / length;
      const dz = (-right * sin - forward * cos) / length;
      const run = input.isDown('shift') ? 1.8 : 1;
      this.position.x += dx * this.speed * run * dt;
      this.position.z += dz * this.speed * run * dt;
      // Turn towards the movement, smoothly: the shortest way round.
      const target = Math.atan2(-dx, -dz);
      let delta = target - this.heading;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.heading += delta * Math.min(1, 12 * dt);
    }
    resolveCircle(this._scene, this._solid, this.position, this.radius);
    this.node.transform.position = this.position;
    this.node.transform.rotation = {
      x: 0,
      y: Math.sin(this.heading / 2),
      z: 0,
      w: Math.cos(this.heading / 2),
    };
  }
}
