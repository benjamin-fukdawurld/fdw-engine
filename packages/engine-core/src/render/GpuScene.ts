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

/** What a GpuScene is created with. */
export interface GpuSceneOptions {
  /**
   * Called by the renderers before they read the items: applies the
   * changes pending elsewhere (a scene graph feeding the GpuScene flushes).
   */
  readonly sync?: () => void;
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
 * - The shadow maps cull its casters on the GPU too, against what the
 *   camera sees (design/p24-gpu-driven.md §3.9).
 * - The layers of the views do not apply to the items of a GpuScene.
 * - Several renderers can draw it: each follows the changes from its own
 *   cursor (touchedSince).
 *
 * A Scene of @fdw/engine-scene keeps its static renderers in one by
 * itself (`new Scene({ gpuScene: true })`): nothing to add nor touch.
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
  // The items touched since the last layout, in order: the touch of
  // `_log[i]` is the change `_logStart + i` (see cursor).
  private _log: Renderable[] = [];
  private _logStart = 0;
  private _version = 0;

  constructor(private readonly _options: GpuSceneOptions = {}) {}

  /** Applies the changes pending elsewhere: see GpuSceneOptions.sync. */
  sync(): void {
    this._options.sync?.();
  }

  /** Adds an item, or changes its options. */
  add(item: Renderable, options: GpuSceneItemOptions = {}): this {
    const previous = this._items.get(item);
    if (!previous || !!previous.dynamic !== !!options.dynamic) {
      this.changed();
    }
    this._items.set(item, options);
    return this;
  }

  /** Removes an item: whether it was there. */
  remove(item: Renderable): boolean {
    if (!this._items.delete(item)) {
      return false;
    }
    this.changed();
    return true;
  }

  /**
   * A static item changed (its transform, its bounds): rewritten at the
   * next frame. Its mesh or material changed: remove and add it again.
   */
  touch(item: Renderable): this {
    if (this._items.has(item)) {
      this._log.push(item);
      // Touched over and over: laid out again rather than kept.
      if (this._log.length > Math.max(1024, 2 * this._items.size)) {
        this.changed();
      }
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

  /** Where the changes are: give it to touchedSince to get the next ones. */
  get cursor(): number {
    return this._logStart + this._log.length;
  }

  /**
   * The static items touched since `cursor` (a value of `cursor`), while
   * the version is the same: for the renderers, each with its own cursor.
   * An item may be there twice, or no longer be in the scene.
   */
  touchedSince(cursor: number): readonly Renderable[] {
    const from = cursor - this._logStart;
    return from <= 0 ? this._log : this._log.slice(from);
  }

  // Items added or removed: laid out again, the touches forgotten.
  private changed(): void {
    this._version++;
    this._logStart += this._log.length;
    this._log = [];
  }
}
