import { CameraCache } from '@fdw/engine-backend';
import type { GpuTexture, Mat4, RenderBackend } from '@fdw/engine-backend';
import { Camera, Material, Mesh } from '@fdw/engine-core';
import type { WorldRenderItem, WorldTransform } from '@fdw/engine-core';
import { Aabb, Frustum, maxScale, transformAabb } from '@fdw/engine-geometry';
import { PatchValues } from './graph';
import { LevelSelection } from './levels';
import { MaxLevel, Patches, PatchTextureWidth } from './patches';

/** The options of a {@link PatchSurface}. */
export interface PatchSurfaceOptions {
  readonly patches: Patches;
  /** A material whose graph calls {@link patchVertex}: one per surface. */
  readonly material: Material;
  /** The world matrix (column-major); the identity by default. */
  readonly matrix?: ArrayLike<number>;
  /** The length of the edges of the triangles on the screen, in pixels (8). */
  readonly edgePixels?: number;
  /** The coarsest level: 2^minLevel quads along an edge of a patch (0). */
  readonly minLevel?: number;
  /** The finest level, up to 6: 64 quads along an edge (6). */
  readonly maxLevel?: number;
  /**
   * How far the displacement moves the points, in object units, both
   * ways: the bounds of the surface and of its patches grow by it (0).
   */
  readonly displacement?: number;
  /** Leaves out the patches outside of the view of the camera (true). */
  readonly cull?: boolean;
  /** Drawn into the shadow maps (true). */
  readonly castShadow?: boolean;
  readonly id?: number;
  readonly label?: string;
}

/** What the last {@link PatchSurface.update} chose. */
export interface PatchSurfaceStats {
  /** The patches drawn, of `patches`. */
  readonly drawn: number;
  readonly patches: number;
  readonly triangles: number;
  /** The patches drawn at each level, from 0 to 6. */
  readonly levels: readonly number[];
}

// The vertex index is read as a float in the shader: exact up to 2^24.
const MaxVertices = 2 ** 24;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * A surface tessellated on the fly, on every backend: its patches drawn
 * from templates subdivided 1, 2, 4… 64 times, each at the level its size
 * on the screen asks for, in a single draw without vertex buffer. The
 * vertices are generated in the vertex shader ({@link patchVertex}).
 *
 * A render item: give it to the renderer with the others, after calling
 * {@link PatchSurface.update} with the camera of the frame.
 *
 * @example
 * ```ts
 * const terrain = new PatchSurface(backend, { patches, material, displacement: 40 });
 * // Each frame:
 * terrain.update(camera, { width, height });
 * renderer.render({ items: [terrain], camera, surface });
 * ```
 */
export class PatchSurface implements WorldRenderItem {
  readonly mesh: Mesh;
  readonly material: Material;
  readonly patches: Patches;
  readonly castShadow: boolean;
  readonly id?: number;

  private readonly _backend: RenderBackend;
  private readonly _selection: LevelSelection;
  private readonly _options: Required<
    Pick<
      PatchSurfaceOptions,
      'edgePixels' | 'minLevel' | 'maxLevel' | 'displacement' | 'cull'
    >
  >;
  private readonly _world: { matrix: Mat4; version: number };
  private readonly _bounds = new Aabb();
  private _boundsVersion = -1;
  private readonly _frustum = new Frustum();
  private readonly _cameras = new WeakMap<Camera, CameraCache>();
  private readonly _patchTexture: GpuTexture;
  private _drawTexture?: GpuTexture;
  private _draws = new Float32Array(0);
  private readonly _retired: GpuTexture[] = [];
  private _stats: PatchSurfaceStats;

  constructor(backend: RenderBackend, options: PatchSurfaceOptions) {
    const maxLevel = options.maxLevel ?? MaxLevel;
    const minLevel = options.minLevel ?? 0;
    if (maxLevel > MaxLevel || minLevel < 0 || minLevel > maxLevel) {
      throw new Error(
        `The levels of a patch surface go from 0 to ${MaxLevel} (minLevel ${minLevel}, maxLevel ${maxLevel})`
      );
    }
    this._backend = backend;
    this.patches = options.patches;
    this.material = options.material;
    this.castShadow = options.castShadow ?? true;
    if (options.id !== undefined) {
      this.id = options.id;
    }
    this._options = {
      edgePixels: options.edgePixels ?? 8,
      minLevel,
      maxLevel,
      displacement: options.displacement ?? 0,
      cull: options.cull ?? true,
    };
    this._world = {
      matrix: new Float32Array(options.matrix ?? identity),
      version: 0,
    };
    this._selection = new LevelSelection(this.patches);
    // No vertex buffer: the vertices come from their index.
    this.mesh = new Mesh({
      description: { vertexBuffers: [], vertexCount: 0 },
      vertices: [],
      label: options.label ?? 'patch surface',
    });

    const patches = this.patches;
    this._patchTexture = backend.textures.createTexture({
      label: `${options.label ?? 'patch surface'} patches`,
      type: '2d',
      format: 'rgba32float',
      dimensions: { width: PatchTextureWidth, height: patches.rows },
      source: patches.data,
    });
    this.material.setValue(PatchValues.patches, this._patchTexture);
    this._stats = {
      drawn: 0,
      patches: patches.count,
      triangles: 0,
      levels: new Array(MaxLevel + 1).fill(0),
    };
    // Nothing drawn before the first update.
    this.writeDraws();
  }

  get world(): WorldTransform {
    return this._world;
  }

  /** The world bounds, displacement included. */
  get bounds(): Aabb {
    if (this._boundsVersion !== this._world.version) {
      transformAabb(this.patches.bounds, this._world.matrix, this._bounds);
      const grow = this.grow();
      for (let axis = 0; axis < 3; axis++) {
        this._bounds.min[axis] -= grow;
        this._bounds.max[axis] += grow;
      }
      this._boundsVersion = this._world.version;
    }
    return this._bounds;
  }

  get stats(): PatchSurfaceStats {
    return this._stats;
  }

  /** Moves the surface: its world matrix (column-major). */
  setMatrix(matrix: ArrayLike<number>): this {
    this._world.matrix.set(matrix);
    this._world.version++;
    return this;
  }

  /**
   * Chooses the level of each patch for a camera, and the patches drawn:
   * once per frame, before rendering. The shadow maps and the other views
   * of the frame draw the same patches. `viewport`: the size of the image
   * in pixels.
   */
  update(camera: Camera, viewport: { width: number; height: number }): this {
    this._retired.splice(0).forEach((texture) => texture.destroy());
    const projection = camera.projection;
    const orthographic = projection.type === 'orthographic';
    const pixelScale =
      projection.type === 'orthographic'
        ? viewport.height / Math.abs(projection.top - projection.bottom)
        : viewport.height /
          (2 * Math.tan((projection.fov * Math.PI) / 180 / 2));
    let frustum: Frustum | undefined;
    if (this._options.cull) {
      let cache = this._cameras.get(camera);
      if (!cache) {
        cache = new CameraCache(camera, this._backend.cameraMath);
        this._cameras.set(camera, cache);
      }
      frustum = this._frustum.setFromMatrix(cache.viewProjectionMatrix.value);
    }

    const { position } = camera;
    const view = {
      position: [position.x, position.y, position.z] as const,
      pixelScale,
      orthographic,
      ...(frustum ? { frustum } : {}),
    };
    const options = { ...this._options, grow: this.grow() };
    const selection = this._selection.update(this._world.matrix, view, options);
    // Too many vertices for the shader: coarser everywhere.
    while (
      vertexCount(selection.counts) > MaxVertices &&
      options.maxLevel > 0
    ) {
      options.maxLevel--;
      options.minLevel = Math.min(options.minLevel, options.maxLevel);
      selection.update(this._world.matrix, view, options);
    }
    this.writeDraws();
    return this;
  }

  /** Destroys the textures of the surface. */
  destroy(): void {
    this._patchTexture.destroy();
    this._drawTexture?.destroy();
    this._retired.splice(0).forEach((texture) => texture.destroy());
  }

  private grow(): number {
    return this._options.displacement * maxScale(this._world.matrix);
  }

  // The draws sorted by level, their texture, the starts of the levels and
  // the vertex count.
  private writeDraws(): void {
    const { counts, levels, edgeLevels } = this._selection;
    const patches = this.patches;
    const drawn = this._selection.drawn;

    const rows = Math.max(Math.ceil(drawn / PatchTextureWidth), 1);
    if (
      !this._drawTexture ||
      this._draws.length < rows * PatchTextureWidth * 4
    ) {
      if (this._drawTexture) {
        this._retired.push(this._drawTexture);
      }
      const capacity = Math.max(
        rows,
        (this._draws.length / PatchTextureWidth / 4) * 2
      );
      this._draws = new Float32Array(capacity * PatchTextureWidth * 4);
      this._drawTexture = this._backend.textures.createTexture({
        label: `${this.mesh.label} draws`,
        type: '2d',
        format: 'rgba32float',
        dimensions: { width: PatchTextureWidth, height: capacity },
      });
      this.material.setValue(PatchValues.draws, this._drawTexture);
    }

    // The first draw and the first vertex of each level.
    const drawStarts = new Array<number>(8).fill(0);
    const vertexStarts = new Array<number>(8).fill(0);
    let draw = 0;
    let vertex = 0;
    for (let level = 0; level <= MaxLevel; level++) {
      drawStarts[level] = draw;
      vertexStarts[level] = vertex;
      draw += counts[level];
      vertex += counts[level] * 6 * 4 ** level;
    }
    // Past the last level: never reached.
    vertexStarts[7] = 1e30;

    const cursor = drawStarts.slice(0, MaxLevel + 1);
    const draws = this._draws;
    const edges = patches.edges;
    for (let patch = 0; patch < levels.length; patch++) {
      const level = levels[patch];
      if (level < 0) {
        continue;
      }
      const i = cursor[level]++ * 4;
      // The step of the grid of each edge on the template of the patch:
      // 2^(level − level of the edge).
      const e = patch * 4;
      draws[i] = patch;
      draws[i + 1] =
        (1 << (level - edgeLevels[edges[e]])) +
        128 * (1 << (level - edgeLevels[edges[e + 1]]));
      draws[i + 2] =
        (1 << (level - edgeLevels[edges[e + 2]])) +
        128 * (1 << (level - edgeLevels[edges[e + 3]]));
      draws[i + 3] = 0;
    }
    this._backend.textures.writeTexture(this._drawTexture as GpuTexture, draws);

    const material = this.material;
    material.setValue(PatchValues.vertexStarts[0], vertexStarts.slice(0, 4));
    material.setValue(PatchValues.vertexStarts[1], vertexStarts.slice(4, 8));
    material.setValue(PatchValues.drawStarts[0], drawStarts.slice(0, 4));
    material.setValue(PatchValues.drawStarts[1], drawStarts.slice(4, 8));
    this.mesh.setVertexCount(vertex);
    this._stats = {
      drawn,
      patches: patches.count,
      triangles: vertex / 3,
      levels: Array.from(counts),
    };
  }
}

function vertexCount(counts: ArrayLike<number>): number {
  let vertices = 0;
  for (let level = 0; level < counts.length; level++) {
    vertices += counts[level] * 6 * 4 ** level;
  }
  return vertices;
}
