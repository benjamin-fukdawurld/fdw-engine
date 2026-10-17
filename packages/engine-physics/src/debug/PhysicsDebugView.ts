import type { IVec3 } from '@fdw/engine-backend';
import { Material, Mesh } from '@fdw/engine-core';
import type { Node, Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { PhysicsWorld, RayHit } from '../api';
import type { DebugOptions } from './DebugLines';
import { DebugLines, defaultDebugColors, drawWorld } from './DebugLines';

// The material of the lines: their color, unlit.
let graph: ReturnType<GraphBuilder['build']> | undefined;
function linesGraph() {
  if (!graph) {
    const g = new GraphBuilder('physics debug lines');
    g.surface({
      shadingModel: 'unlit',
      baseColor: g.attribute('color', BuiltinTypes.vec4f).swizzle('rgb'),
    });
    graph = g.build();
  }
  return graph;
}

interface Ray {
  readonly origin: IVec3;
  readonly end: IVec3;
  readonly hit?: IVec3;
  life: number;
}

export interface PhysicsDebugViewOptions extends DebugOptions {
  /** How long a ray stays drawn, in seconds. Default 1. */
  readonly rayLife?: number;
}

/**
 * The debug view of a physics world, in a scene: the shapes of the
 * colliders, the contacts, the joints, and the rays cast, drawn in lines
 * by a node of the scene. Call `update(dt)` once per frame.
 */
export class PhysicsDebugView {
  /** The node of the lines; hide it, or the view, to stop drawing. */
  readonly node: Node;
  readonly lines = new DebugLines();
  private _mesh?: Mesh;
  private readonly _material = new Material({
    graph: linesGraph(),
    label: 'physics debug lines',
  });
  private readonly _rays: Ray[] = [];
  private _enabled = true;

  constructor(
    readonly scene: Scene,
    readonly world: PhysicsWorld,
    readonly options: PhysicsDebugViewOptions = {},
  ) {
    this.node = scene.root.add({ name: 'physics debug' });
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(enabled: boolean) {
    this._enabled = enabled;
    this.node.visible = enabled && this.lines.count > 0;
  }

  /**
   * Draws a ray for a while (`rayLife`): from `origin` along `direction`
   * (normalized) to its hit, or to `maxDistance`.
   */
  ray(
    origin: IVec3,
    direction: IVec3,
    maxDistance: number,
    hit?: RayHit,
  ): void {
    const distance = hit?.distance ?? maxDistance;
    this._rays.push({
      origin,
      end: {
        x: origin.x + direction.x * distance,
        y: origin.y + direction.y * distance,
        z: origin.z + direction.z * distance,
      },
      hit: hit?.point,
      life: this.options.rayLife ?? 1,
    });
  }

  /** Redraws the lines from the world as it is; `dt` ages the rays. */
  update(dt = 0): void {
    for (let i = this._rays.length - 1; i >= 0; i--) {
      this._rays[i].life -= dt;
      if (this._rays[i].life < 0) {
        this._rays.splice(i, 1);
      }
    }
    if (!this._enabled) {
      return;
    }
    const { lines } = this;
    lines.clear();
    drawWorld(this.world, lines, this.options);
    const colors = { ...defaultDebugColors, ...this.options.colors };
    for (const { origin: o, end: e, hit } of this._rays) {
      lines.line(o.x, o.y, o.z, e.x, e.y, e.z, colors.ray);
      if (hit) {
        lines.cross(hit, 0.15, colors.hit);
      }
    }
    this.upload();
  }

  /** Removes the node of the lines and frees their mesh. */
  destroy(): void {
    this.node.remove();
    this._mesh?.destroy();
  }

  private upload(): void {
    const { lines } = this;
    this.node.visible = lines.count > 0;
    if (lines.count === 0) {
      return;
    }
    const positions = lines.positions.subarray(0, lines.count * 3);
    const colors = lines.colors.subarray(0, lines.count * 4);
    if (!this._mesh) {
      this._mesh = new Mesh({
        label: 'physics debug lines',
        description: {
          vertexBuffers: [
            {
              stride: 12,
              stepMode: 'vertex',
              attributes: [
                { semantic: 'position', format: 'float32x3', offset: 0 },
              ],
            },
            {
              stride: 16,
              stepMode: 'vertex',
              attributes: [
                { semantic: 'color', format: 'float32x4', offset: 0 },
              ],
            },
          ],
          vertexCount: lines.count,
          topology: 'line-list',
        },
        vertices: [positions, colors],
      });
      this.node.setMesh(this._mesh, this._material, { castShadow: false });
      return;
    }
    this._mesh
      .setVertices(0, positions)
      .setVertices(1, colors)
      .setVertexCount(lines.count);
  }
}
