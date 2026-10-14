import type {
  GpuTexture,
  GpuTextureFormat,
  Mat4,
  RenderBackend,
} from '@fdw/engine-backend';
import {
  Material,
  OcclusionCuller,
  OcclusionPassContext,
  OcclusionView,
  Renderable,
  RenderGraph,
  TextureHandle,
} from '@fdw/engine-core';
import type { Aabb } from '@fdw/engine-geometry';
import {
  firstLevelGraph,
  levelName,
  nextLevelGraph,
  testGraph,
} from './graphs';

export interface OcclusionCullingOptions {
  /**
   * How much farther than the opaque items, relatively, a box must be to be
   * hidden: against the rounding of the depths (an item behind its own
   * surface). Default 0.001.
   */
  readonly margin?: number;
  /**
   * The boxes are grown by the distance the camera moved since the
   * previous frame, times this: what moving reveals is found visible a
   * little earlier, while the results are on their way. Default 2.
   */
  readonly motion?: number;
  /**
   * Results awaited at most at once: no test is added while they are, so
   * that a slow readback does not pile up. Default 2.
   */
  readonly maxPending?: number;
}

/** What the occlusion culling of a view did. */
export interface OcclusionStats {
  // The boxes tested by the last test.
  readonly tested: number;
  // Those it found hidden.
  readonly hidden: number;
  // Frames between the last test applied and its result.
  readonly latency: number;
}

// What is known of an item.
interface ItemState {
  // The frame since which the item is given for the camera, without
  // interruption: the results of earlier tests are out of date.
  since: number;
  // The last frame it was given.
  last: number;
  // The frame of the latest test applied, and its result.
  tested: number;
  visible: boolean;
}

// The boxes of a frame and the texture of their results: a texel each,
// SlotsPerRow per row.
const SlotsPerRow = 256;
const PyramidFormat: GpuTextureFormat = 'r32float';

/**
 * Occlusion culling by a depth pyramid (Hi-Z), on every backend: the items
 * hidden by the opaque items of the previous frames are not drawn.
 *
 * Each frame, after the opaque items, full screen passes reduce the depth
 * buffer to a pyramid (the farthest depth of 2 × 2 texels, level after
 * level), then test the box of every item given for the camera against it,
 * a texel per box. The results are read back without waiting, and used as
 * soon as they arrive, one to three frames later: an item found hidden is
 * left out until a test finds it visible again. What it hides cannot be
 * seen, so the image does not change; what moving reveals may appear a
 * frame or two late, which the `motion` option makes rarer.
 *
 * Give it to the scene passes of one view (option `occlusion` of
 * Renderer.render and addScenePasses). The graph must know the size of the
 * frame: render() gives it; a graph of the application is created with it
 * (`new RenderGraph({ size })`) unless its targets have an absolute size.
 */
export class OcclusionCulling implements OcclusionCuller {
  private readonly _margin: number;
  private readonly _motion: number;
  private readonly _maxPending: number;
  private readonly _states = new WeakMap<Renderable, ItemState>();
  private _frame = 0;
  private _view?: OcclusionView;
  private _previous?: [number, number, number];
  private _grow = 0;
  // Whether this frame tests its boxes, and their items and bounds.
  private _testing = false;
  private _items: Renderable[] = [];
  private _bounds = new Float32Array(SlotsPerRow * 8);
  private _pending = 0;
  private _stats: OcclusionStats = { tested: 0, hidden: 0, latency: 0 };
  private _textures?: {
    readonly backend: RenderBackend;
    readonly rows: number;
    readonly bounds: GpuTexture;
    readonly visibility: GpuTexture;
  };
  private _firstLevel?: Material;
  private readonly _nextLevels: Material[] = [];
  private readonly _tests = new Map<number, Material>();
  private _destroyed = false;

  constructor(options: OcclusionCullingOptions = {}) {
    this._margin = options.margin ?? 0.001;
    this._motion = options.motion ?? 2;
    this._maxPending = options.maxPending ?? 2;
  }

  /** What the last results said. */
  get stats(): OcclusionStats {
    return this._stats;
  }

  /**
   * Whether the latest results found an item hidden: it is not drawn while
   * it stays in view (for a view of the culling).
   */
  isHidden(item: Renderable): boolean {
    const state = this._states.get(item);
    return (
      state !== undefined &&
      state.last === this._frame &&
      state.tested >= state.since &&
      !state.visible
    );
  }

  begin(view: OcclusionView): void {
    this._frame++;
    this._view = view;
    const { x, y, z } = view.position;
    this._grow = this._previous
      ? Math.hypot(
          x - this._previous[0],
          y - this._previous[1],
          z - this._previous[2]
        ) * this._motion
      : 0;
    this._previous = [x, y, z];
    this._testing = this._pending < this._maxPending;
    this._items = [];
  }

  visible(item: Renderable, bounds: Aabb | undefined): boolean {
    if (!bounds) {
      return true;
    }
    let state = this._states.get(item);
    const frame = this._frame;
    if (!state) {
      state = { since: frame, last: frame, tested: -1, visible: true };
      this._states.set(item, state);
    } else if (state.last < frame - 1) {
      // Back in view: what was found before is out of date.
      state.since = frame;
    }
    state.last = frame;
    if (this._testing) {
      this.record(item, bounds);
    }
    return state.tested < state.since || state.visible;
  }

  addPasses(graph: RenderGraph, context: OcclusionPassContext): void {
    const view = this._view;
    const items = this._items;
    if (!this._testing || !view || items.length === 0) {
      return;
    }
    const { renderer, name, depth } = context;
    const size = graph.pixelSize(depth);
    if (!size) {
      throw new Error(
        `"${name}": the occlusion culling needs the size of the depth: create the graph with the size of the frame (new RenderGraph({ size }))`
      );
    }
    const backend = renderer.backend;
    const renderable = backend.capabilities?.renderableFormats;
    if (renderable && !renderable.includes('rgba16float')) {
      throw new Error(
        `"${name}": the occlusion culling renders to ${PyramidFormat} textures, which the backend cannot (EXT_color_buffer_float in WebGL2)`
      );
    }
    const textures = this.textures(backend, items.length);
    backend.textures.writeTexture(
      textures.bounds,
      this._bounds.subarray(0, textures.rows * SlotsPerRow * 8)
    );

    // The pyramid: each level half the previous one, rounded up.
    const levels: TextureHandle[] = [];
    let source = depth;
    let sourceSize = size;
    for (
      let level = 0;
      level === 0 || sourceSize.width > 1 || sourceSize.height > 1;
      level++
    ) {
      const levelSize = {
        width: Math.ceil(sourceSize.width / 2),
        height: Math.ceil(sourceSize.height / 2),
      };
      const material = this.levelMaterial(level);
      material.setValue('size', [levelSize.width, levelSize.height]);
      material.setValue('sourceSize', [sourceSize.width, sourceSize.height]);
      if (level === 0) {
        material.setValue(
          'inverseProjection',
          backend.cameraMath.getInverseMatrix(view.projection)
        );
      }
      const passName = `${name} occlusion level ${level}`;
      source = renderer.addFullscreenPass(graph, passName, {
        material,
        inputs: { [level === 0 ? 'depth' : 'source']: source },
        target: graph.createTexture(passName, {
          format: PyramidFormat,
          size: levelSize,
        }),
        format: PyramidFormat,
      });
      levels.push(source);
      sourceSize = levelSize;
    }

    // The test of the boxes, then their results read back.
    const test = this.testMaterial(levels.length);
    test.setValue('view', view.view);
    test.setValue('viewProjection', view.viewProjection);
    test.setValue('depthSize', [size.width, size.height]);
    test.setValue('near', nearOf(view.projection, backend));
    test.setValue('margin', this._margin);
    test.setValue('slots', [SlotsPerRow, textures.rows]);
    test.setValue('bounds', textures.bounds);
    const results = renderer.addFullscreenPass(
      graph,
      `${name} occlusion test`,
      {
        material: test,
        inputs: Object.fromEntries(
          levels.map((level, i) => [levelName(i), level])
        ),
        target: graph.importTexture(
          `${name} occlusion results`,
          textures.visibility
        ),
        format: 'r8unorm',
      }
    );
    const frame = this._frame;
    graph.addCopyPass(`${name} occlusion readback`, (pass) => {
      pass.read(results, 'copy-src');
      pass.hasSideEffects();
      return {
        // Read once the commands of the frame are submitted.
        execute: () => {
          this._pending++;
          queueMicrotask(() => this.read(textures, items, frame));
        },
      };
    });
  }

  destroy(): void {
    this._destroyed = true;
    this._textures?.bounds.destroy();
    this._textures?.visibility.destroy();
    this._textures = undefined;
  }

  // Keeps the box of an item for the test of this frame, grown by the
  // motion of the camera.
  private record(item: Renderable, bounds: Aabb): void {
    const slot = this._items.length;
    this._items.push(item);
    if ((slot + 1) * 8 > this._bounds.length) {
      const grown = new Float32Array(this._bounds.length * 2);
      grown.set(this._bounds);
      this._bounds = grown;
    }
    const o = slot * 8;
    const grow = this._grow;
    const { min, max } = bounds;
    this._bounds[o] = min[0] - grow;
    this._bounds[o + 1] = min[1] - grow;
    this._bounds[o + 2] = min[2] - grow;
    this._bounds[o + 4] = max[0] + grow;
    this._bounds[o + 5] = max[1] + grow;
    this._bounds[o + 6] = max[2] + grow;
  }

  // The textures of the boxes and of the results, for `count` boxes:
  // larger ones when they do not fit.
  private textures(
    backend: RenderBackend,
    count: number
  ): NonNullable<OcclusionCulling['_textures']> {
    const rows = Math.ceil(count / SlotsPerRow);
    const current = this._textures;
    if (current && current.backend === backend && current.rows >= rows) {
      return current;
    }
    // Still read by the commands recorded: destroyed after them.
    if (current) {
      const retired = current;
      queueMicrotask(() => {
        retired.bounds.destroy();
        retired.visibility.destroy();
      });
    }
    const capacity = Math.max(rows, (current?.rows ?? 0) * 2, 4);
    if (this._bounds.length < capacity * SlotsPerRow * 8) {
      const grown = new Float32Array(capacity * SlotsPerRow * 8);
      grown.set(this._bounds);
      this._bounds = grown;
    }
    this._textures = {
      backend,
      rows: capacity,
      bounds: backend.textures.createTexture({
        label: 'occlusion boxes',
        type: '2d',
        format: 'rgba32float',
        dimensions: { width: SlotsPerRow * 2, height: capacity },
        usage: ['sampled', 'copy-dst'],
      }),
      visibility: backend.textures.createTexture({
        label: 'occlusion results',
        type: '2d',
        format: 'r8unorm',
        dimensions: { width: SlotsPerRow, height: capacity },
        usage: ['render-attachment', 'copy-src'],
      }),
    };
    return this._textures;
  }

  // Applies the results of the test of a frame to its items.
  private async read(
    textures: NonNullable<OcclusionCulling['_textures']>,
    items: readonly Renderable[],
    frame: number
  ): Promise<void> {
    try {
      const rows = Math.ceil(items.length / SlotsPerRow);
      const data = new Uint8Array(
        await textures.backend.textures.readTexture(textures.visibility, {
          x: 0,
          y: 0,
          width: SlotsPerRow,
          height: rows,
        })
      );
      if (this._destroyed) {
        return;
      }
      let hidden = 0;
      for (let i = 0; i < items.length; i++) {
        const state = this._states.get(items[i]);
        // Results older than the return of the item in view, or than those
        // applied already, are out of date.
        if (!state || frame < state.since || frame <= state.tested) {
          continue;
        }
        state.tested = frame;
        state.visible = data[i] >= 128;
        if (!state.visible) {
          hidden++;
        }
      }
      this._stats = {
        tested: items.length,
        hidden,
        latency: this._frame - frame,
      };
    } catch {
      // A texture destroyed meanwhile (resized): the next test replaces it.
    } finally {
      this._pending--;
    }
  }

  private levelMaterial(level: number): Material {
    if (level === 0) {
      this._firstLevel ??= new Material({
        graph: firstLevelGraph(),
        label: 'occlusion pyramid',
      });
      return this._firstLevel;
    }
    // A material per level: their values differ in a frame.
    let material = this._nextLevels[level - 1];
    if (!material) {
      material = new Material({
        graph: nextLevelGraph(),
        label: `occlusion pyramid ${level}`,
      });
      this._nextLevels[level - 1] = material;
    }
    return material;
  }

  private testMaterial(levels: number): Material {
    let material = this._tests.get(levels);
    if (!material) {
      material = new Material({
        graph: testGraph(levels),
        label: 'occlusion test',
      });
      this._tests.set(levels, material);
    }
    return material;
  }
}

// The distance of the near plane along the axis of the camera.
function nearOf(projection: Mat4, backend: RenderBackend): number {
  const inverse = backend.cameraMath.getInverseMatrix(projection);
  // The point at depth 0 on the axis: inverse × (0, 0, 0, 1).
  return -inverse[14] / inverse[15];
}
