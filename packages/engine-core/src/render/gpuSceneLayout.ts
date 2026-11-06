import type { GpuBuffer, RenderBackend } from '@fdw/engine-backend';
import { Aabb } from '@fdw/engine-geometry';
import type { GpuScene } from './GpuScene';
import type { Material } from './Material';
import type { Mesh } from './Mesh';
import type { Renderable } from './RenderSource';

/** The items of a GpuScene sharing a mesh and a material: one run. */
export interface SceneBucket {
  readonly material: Material;
  readonly mesh: Mesh;
  // Its items cast shadows.
  readonly caster: boolean;
  readonly items: Renderable[];
  // Its first candidate.
  start: number;
}

// Whole workgroups of the culling: the threads past the end read the
// buffers too.
const Workgroup = 64;
const whole = (n: number) => Math.ceil(Math.max(n, 1) / Workgroup) * Workgroup;

/**
 * The layout of the opaque items of a GpuScene on the GPU, for a renderer:
 * the candidates of the culling grouped by run (mesh and material), their
 * boxes (center, half extents: two vec4f each) and their rows in the object
 * table, in buffers kept from frame to frame. Laid out again when items
 * are added or removed; otherwise only the changed items are written.
 *
 * The runs of the shadow casters come first: the shadow maps cull the
 * first `casterCount` candidates, in the first `casterBuckets` runs.
 */
export class GpuSceneLayout {
  version = -1;
  // Where the changes of the scene were read up to (GpuScene.cursor).
  cursor = 0;
  buckets: SceneBucket[] = [];
  casterBuckets = 0;
  casterCount = 0;
  // The transparent items, drawn as usual.
  transparent: Renderable[] = [];
  // The dynamic items, written again at each frame.
  dynamic: Renderable[] = [];
  count = 0;
  // The union of the boxes: the receivers of the shadows.
  readonly bounds = Aabb.empty();
  private _slots = new Map<Renderable, number>();
  private _boxes = new Float32Array(0);
  private _rows = new Uint32Array(0);
  private _boxBuffer?: GpuBuffer;
  private _rowBuffer?: GpuBuffer;

  constructor(
    private readonly _backend: RenderBackend,
    // Destroys a buffer once the commands recorded with it are submitted.
    private readonly _retire: (buffer: GpuBuffer) => void,
  ) {}

  /** The buffers of the boxes and the rows of the candidates. */
  get buffers(): { readonly boxes: GpuBuffer; readonly rows: GpuBuffer } {
    if (!this._boxBuffer || !this._rowBuffer) {
      throw new Error('The GPU scene is not laid out');
    }
    return { boxes: this._boxBuffer, rows: this._rowBuffer };
  }

  /**
   * Brings the layout up to date: laid out again when the items changed,
   * else the touched and dynamic items written. `bounds` and `row`: the
   * world bounds and the row in the object table of an item (written if
   * it changed).
   */
  sync(
    scene: GpuScene,
    bounds: (item: Renderable) => Aabb | undefined,
    row: (item: Renderable) => number,
  ): void {
    if (scene.version !== this.version) {
      this.cursor = scene.cursor;
      this.layOut(scene, bounds, row);
      return;
    }
    const touched = scene.touchedSince(this.cursor);
    this.cursor = scene.cursor;
    for (const list of [touched, this.dynamic]) {
      for (const item of list) {
        const slot = this._slots.get(item);
        if (slot === undefined) {
          continue;
        }
        const box = bounds(item);
        this.writeBox(slot, box);
        if (box) {
          this.bounds.union(box);
        }
        this._rows[slot] = row(item);
        this.boxBuffer().write(slot * 32, this._boxes.buffer, slot * 32, 32);
        this.rowBuffer().write(slot * 4, this._rows.buffer, slot * 4, 4);
      }
    }
  }

  destroy(): void {
    this._boxBuffer?.destroy();
    this._rowBuffer?.destroy();
    this._boxBuffer = undefined;
    this._rowBuffer = undefined;
  }

  // The runs, the candidates and their buffers, from the items.
  private layOut(
    scene: GpuScene,
    bounds: (item: Renderable) => Aabb | undefined,
    row: (item: Renderable) => number,
  ): void {
    this.version = scene.version;
    // By caster, material, then mesh.
    const buckets = [
      new Map<Material, Map<Mesh, SceneBucket>>(),
      new Map<Material, Map<Mesh, SceneBucket>>(),
    ];
    this.transparent = [];
    this.dynamic = [];
    for (const item of scene.items()) {
      if (item.material.renderState.alphaMode === 'blend') {
        this.transparent.push(item);
        continue;
      }
      if (scene.isDynamic(item)) {
        this.dynamic.push(item);
      }
      const caster = item.castShadow !== false;
      const byMaterial = buckets[caster ? 0 : 1];
      let meshes = byMaterial.get(item.material);
      if (!meshes) {
        meshes = new Map();
        byMaterial.set(item.material, meshes);
      }
      let bucket = meshes.get(item.mesh);
      if (!bucket) {
        bucket = {
          material: item.material,
          mesh: item.mesh,
          caster,
          items: [],
          start: 0,
        };
        meshes.set(item.mesh, bucket);
      }
      bucket.items.push(item);
    }
    // The casters first, then by material and by mesh: the runs sharing a
    // material follow each other (one multiple draw for the meshes of an
    // arena).
    this.buckets = buckets.flatMap((byMaterial) =>
      [...byMaterial.values()].flatMap((meshes) => [...meshes.values()]),
    );
    let count = 0;
    this.casterBuckets = 0;
    this.casterCount = 0;
    for (const bucket of this.buckets) {
      bucket.start = count;
      count += bucket.items.length;
      if (bucket.caster) {
        this.casterBuckets++;
        this.casterCount = count;
      }
    }
    this.count = count;
    const capacity = whole(count);
    if (this._boxes.length < capacity * 8) {
      this._boxes = new Float32Array(capacity * 16);
      this._rows = new Uint32Array(capacity * 2);
    }
    this._slots = new Map();
    this.bounds.makeEmpty();
    for (const bucket of this.buckets) {
      bucket.items.forEach((item, i) => {
        const slot = bucket.start + i;
        this._slots.set(item, slot);
        const box = bounds(item);
        this.writeBox(slot, box);
        if (box) {
          this.bounds.union(box);
        }
        this._rows[slot] = row(item);
      });
    }
    this.boxBuffer().write(0, this._boxes.buffer, 0, count * 32);
    this.rowBuffer().write(0, this._rows.buffer, 0, count * 4);
  }

  // The box of a candidate: center, then half extents (infinite without
  // bounds).
  private writeBox(slot: number, box: Aabb | undefined): void {
    const o = slot * 8;
    const boxes = this._boxes;
    if (box) {
      for (let axis = 0; axis < 3; axis++) {
        boxes[o + axis] = (box.min[axis] + box.max[axis]) / 2;
        boxes[o + 4 + axis] = (box.max[axis] - box.min[axis]) / 2;
      }
    } else {
      boxes.fill(0, o, o + 4);
      boxes.fill(1e30, o + 4, o + 7);
    }
    boxes[o + 3] = 0;
    boxes[o + 7] = 0;
  }

  private boxBuffer(): GpuBuffer {
    return (this._boxBuffer = this.fitted(
      this._boxBuffer,
      this._boxes,
      'boxes',
    ));
  }

  private rowBuffer(): GpuBuffer {
    return (this._rowBuffer = this.fitted(this._rowBuffer, this._rows, 'rows'));
  }

  // A buffer as large as the array, the previous one if it is.
  private fitted(
    buffer: GpuBuffer | undefined,
    data: ArrayBufferView,
    label: string,
  ): GpuBuffer {
    if (buffer && buffer.size >= data.byteLength) {
      return buffer;
    }
    if (buffer) {
      this._retire(buffer);
    }
    return this._backend.buffers.create({
      label: `gpu scene ${label}`,
      size: Math.max(data.byteLength, 256),
      usage: ['storage', 'copy-dst'],
    });
  }
}
