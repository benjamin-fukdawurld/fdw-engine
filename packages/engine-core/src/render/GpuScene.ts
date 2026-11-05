import type { Renderable } from './RenderSource';

/** How an item is kept by a GpuScene: see GpuScene.add. */
export interface GpuSceneItemOptions {
  /**
   * Its transform or bounds change from frame to frame: checked at each
   * frame. Default false: a static item, rewritten only after
   * GpuScene.touch.
   */
  readonly dynamic?: boolean;
}

/**
 * Items kept on the GPU from frame to frame (design/p24-gpu-driven.md §3.8):
 * their boxes, their rows in the object table and their runs stay in GPU
 * buffers, and the culling on the GPU tests them all at each frame. The CPU
 * no longer prepares them one by one: it prepares a run per mesh and
 * material, and writes only what changed (the items added, removed,
 * touched, and the dynamic ones).
 *
 * Give it to the scene passes with `gpuCulling` (option `gpuScene` of
 * Renderer.render and addScenePasses). Where the backend cannot cull on
 * the GPU (WebGL2), its items are drawn as a list, culled on the CPU.
 *
 * - The transparent items are drawn as usual (sorted on the CPU each
 *   frame).
 * - The shadow maps query the items on the CPU (their casters are not
 *   culled by the camera).
 * - The layers of the views do not apply to the items of a GpuScene.
 * - A GpuScene is drawn by one renderer: it consumes the changes.
 *
 * @example
 * ```ts
 * const city = new GpuScene();
 * for (const building of buildings) city.add(building);
 * city.add(bus, { dynamic: true });
 * // Each frame:
 * renderer.render({ gpuScene: city, camera, surface, gpuCulling: true });
 * // A static item moved:
 * crane.transform.position = { x: 3 };
 * city.touch(crane);
 * ```
 */
export class GpuScene {
  private readonly _items = new Map<Renderable, GpuSceneItemOptions>();
  private readonly _touched = new Set<Renderable>();
  private _version = 0;

  /** Adds an item, or changes its options. */
  add(item: Renderable, options: GpuSceneItemOptions = {}): this {
    const previous = this._items.get(item);
    if (!previous || !!previous.dynamic !== !!options.dynamic) {
      this._version++;
    }
    this._items.set(item, options);
    return this;
  }

  /** Removes an item: whether it was there. */
  remove(item: Renderable): boolean {
    this._touched.delete(item);
    if (!this._items.delete(item)) {
      return false;
    }
    this._version++;
    return true;
  }

  /**
   * A static item changed (its transform, its bounds): rewritten at the
   * next frame. Its mesh or material changed: remove and add it again.
   */
  touch(item: Renderable): this {
    if (this._items.has(item)) {
      this._touched.add(item);
    }
    return this;
  }

  has(item: Renderable): boolean {
    return this._items.has(item);
  }

  get size(): number {
    return this._items.size;
  }

  /** The items, in the order they were added. */
  items(): IterableIterator<Renderable> {
    return this._items.keys();
  }

  /** Whether an item is dynamic (see GpuSceneItemOptions). */
  isDynamic(item: Renderable): boolean {
    return this._items.get(item)?.dynamic === true;
  }

  /**
   * Changes when items are added or removed: the renderer lays the items
   * out again.
   */
  get version(): number {
    return this._version;
  }

  /** The static items touched since the last call: for the renderer. */
  takeTouched(): Renderable[] {
    const touched = [...this._touched];
    this._touched.clear();
    return touched;
  }
}
