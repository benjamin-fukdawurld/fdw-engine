import type { GpuTexture, RenderBackend } from '@fdw/engine-backend';
import { pickIds, type RenderGraph, type SceneOutput } from '@fdw/engine-core';
import type { Node, Scene } from '@fdw/engine-scene';
import type { ViewportPoint } from '../Viewport';

/**
 * Finds the objects under a point or in a rectangle by the identifiers the
 * scene passes write for each pixel (the 'object-id' output): exact to the
 * pixel, whatever the meshes, the instancing or the masked materials. It
 * owns the texture of the identifiers, of the size of the color target.
 *
 * ```ts
 * const picker = Picker.forScene(backend, scene);
 * // Each frame, with the other passes of the scene:
 * renderer.addScenePasses(graph, {
 *   source: scene,
 *   outputs: { id: picker.output(graph, width, height) },
 *   …
 * });
 * // Later (asynchronous: a frame or two):
 * const node = await picker.pick({ x, y });
 * ```
 */
export class Picker<T> {
  private _texture?: GpuTexture;

  constructor(
    readonly backend: RenderBackend,
    /** The object of an identifier, or undefined to ignore it. */
    readonly resolve: (id: number) => T | undefined,
  ) {}

  /**
   * A picker of the nodes of a scene. `resolve` maps the node drawn to the
   * one to select (its model, a group), or to undefined (not selectable):
   * the drawn node by default.
   */
  static forScene(
    backend: RenderBackend,
    scene: Scene,
    resolve: (node: Node) => Node | undefined = (node) => node,
  ): Picker<Node> {
    return new Picker(backend, (id) => {
      const entity = scene.entityOf(id);
      return entity === undefined ? undefined : resolve(scene.node(entity));
    });
  }

  /** The texture of the identifiers, once output() made it. */
  get texture(): GpuTexture | undefined {
    return this._texture;
  }

  /**
   * The output of the scene passes writing the identifiers into the texture
   * of the picker, recreated when the size changes: give it the size of the
   * color target. Scene passes with one sample per pixel (integers are not
   * resolved).
   */
  output(graph: RenderGraph, width: number, height: number): SceneOutput {
    const texture = this._texture;
    if (
      texture?.dimensions.width !== width ||
      texture.dimensions.height !== height
    ) {
      texture?.destroy();
      this._texture = this.backend.textures.createTexture({
        label: 'picking identifiers',
        type: '2d',
        format: 'r32uint',
        dimensions: { width, height },
        usage: ['render-attachment', 'copy-src'],
      });
    }
    return {
      format: 'r32uint',
      value: 'object-id',
      target: graph.importTexture(
        'picking identifiers',
        this._texture as GpuTexture,
      ),
    };
  }

  /** The object under a pixel, if any. */
  async pick(point: ViewportPoint): Promise<T | undefined> {
    const [first] = await this.pickRect(point, point);
    return first;
  }

  /**
   * The objects with a pixel in the rectangle between two corners, in any
   * order of the corners: distinct, by identifier.
   */
  async pickRect(from: ViewportPoint, to: ViewportPoint): Promise<T[]> {
    if (!this._texture) {
      return [];
    }
    const x = Math.floor(Math.min(from.x, to.x));
    const y = Math.floor(Math.min(from.y, to.y));
    let ids: number[];
    try {
      ids = await pickIds(this.backend, this._texture, {
        x,
        y,
        width: Math.floor(Math.max(from.x, to.x)) - x + 1,
        height: Math.floor(Math.max(from.y, to.y)) - y + 1,
      });
    } catch {
      // The texture was replaced (resized) or the point is out of it.
      return [];
    }
    const found = new Set<T>();
    for (const id of ids) {
      const item = this.resolve(id);
      if (item !== undefined) {
        found.add(item);
      }
    }
    return [...found];
  }

  destroy(): void {
    this._texture?.destroy();
    this._texture = undefined;
  }
}
