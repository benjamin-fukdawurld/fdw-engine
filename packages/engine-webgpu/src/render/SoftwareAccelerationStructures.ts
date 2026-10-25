import type {
  BottomLevelDescriptor,
  GpuBottomLevel,
  GpuTopLevel,
  TopLevelDescriptor,
  TopLevelInstance,
} from '@fdw/engine-backend';
import {
  buildBvh,
  buildTriangleBvh,
  BvhNodeFloats,
  BvhRef,
  invertAffine,
  transformBox,
  TriangleFloats,
} from '@fdw/engine-geometry';

// The acceleration structures of WebGPU, which has no ray tracing: BVHs
// built on the CPU, in storage buffers, traversed by the code the WGSL
// generator adds to the programs that trace rays (softwareRays.ts).
//
// The bottom levels of all the meshes share two buffers of the backend:
// their nodes, and their triangles. The top level of a scene has its own
// buffer: a header (vec4 of u32: the reference and count of its root, the
// vec4 where its instances start, their number), its nodes, then for each
// instance, in the order of its leaves, 4 vec4: the rows of its world to
// object matrix, then (as u32) the root of its bottom level (reference and
// count, see BvhRef), its mask, and its index in the update.

/** Bytes of a node and of a triangle in the buffers. */
const NodeBytes = BvhNodeFloats * 4;
const TriangleBytes = TriangleFloats * 4;
/** vec4 per instance record of the top level. */
export const InstanceVec4s = 4;

/**
 * A storage buffer of fixed size units, allocated first fit, growing by
 * copying into a larger one (its generation then changes: bind groups
 * holding it must be made again).
 */
class UnitPool {
  buffer: GPUBuffer;
  generation = 0;
  private _capacity: number;
  // Free ranges [start, count], sorted by start.
  private _free: [number, number][];

  constructor(
    private readonly device: GPUDevice,
    private readonly unitBytes: number,
    capacity: number,
    private readonly label: string,
  ) {
    this._capacity = capacity;
    this._free = [[0, capacity]];
    this.buffer = this.createBuffer(capacity);
  }

  private createBuffer(capacity: number): GPUBuffer {
    return this.device.createBuffer({
      label: this.label,
      size: capacity * this.unitBytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
  }

  /** The first unit of `count` free units, the buffer grown if needed. */
  allocate(count: number): number {
    for (let i = 0; i < this._free.length; i++) {
      const [start, size] = this._free[i];
      if (size >= count) {
        if (size === count) {
          this._free.splice(i, 1);
        } else {
          this._free[i] = [start + count, size - count];
        }
        return start;
      }
    }
    this.grow(count);
    return this.allocate(count);
  }

  release(start: number, count: number): void {
    if (count === 0) {
      return;
    }
    let i = 0;
    while (i < this._free.length && this._free[i][0] < start) {
      i++;
    }
    this._free.splice(i, 0, [start, count]);
    // Merges with the neighbors.
    for (const at of [i, i - 1]) {
      const next = this._free[at + 1];
      const current = this._free[at];
      if (current && next && current[0] + current[1] === next[0]) {
        current[1] += next[1];
        this._free.splice(at + 1, 1);
      }
    }
  }

  write(unit: number, data: ArrayBufferView<ArrayBuffer>): void {
    this.device.queue.writeBuffer(
      this.buffer,
      unit * this.unitBytes,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  private grow(count: number): void {
    const capacity = Math.max(this._capacity * 2, this._capacity + count);
    const buffer = this.createBuffer(capacity);
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(
      this.buffer,
      0,
      buffer,
      0,
      this._capacity * this.unitBytes,
    );
    this.device.queue.submit([encoder.finish()]);
    // Freed once the commands using it are done.
    this.buffer.destroy();
    this.buffer = buffer;
    const last = this._free[this._free.length - 1];
    if (last && last[0] + last[1] === this._capacity) {
      last[1] += capacity - this._capacity;
    } else {
      this._free.push([this._capacity, capacity - this._capacity]);
    }
    this._capacity = capacity;
    this.generation++;
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

/** The buffers shared by the bottom levels of a device. */
export class SoftwareBvhPools {
  readonly nodes: UnitPool;
  readonly triangles: UnitPool;

  constructor(device: GPUDevice) {
    this.nodes = new UnitPool(device, NodeBytes, 4096, 'bvh nodes');
    this.triangles = new UnitPool(device, TriangleBytes, 8192, 'bvh triangles');
  }

  get generation(): number {
    return this.nodes.generation + this.triangles.generation;
  }

  destroy(): void {
    this.nodes.destroy();
    this.triangles.destroy();
  }
}

export class SoftwareBottomLevel implements GpuBottomLevel {
  readonly label?: string;
  readonly triangleCount: number;
  /** Its root, in the buffers of the pools. */
  readonly root: BvhRef;
  /** The box of its triangles: min xyz, max xyz. */
  readonly bounds: Float32Array;
  private readonly _nodeStart: number;
  private readonly _nodeCount: number;
  private readonly _triangleStart: number;
  private _destroyed = false;

  constructor(
    private readonly pools: SoftwareBvhPools,
    { positions, indices, label }: BottomLevelDescriptor,
  ) {
    this.label = label;
    const bvh = buildTriangleBvh(positions, indices);
    this.triangleCount = bvh.triangleCount;
    this.bounds = bvh.bounds;
    this._nodeCount = bvh.nodeCount;
    this._nodeStart =
      bvh.nodeCount > 0 ? pools.nodes.allocate(bvh.nodeCount) : 0;
    this._triangleStart =
      bvh.triangleCount > 0 ? pools.triangles.allocate(bvh.triangleCount) : 0;
    // The references made absolute: nodes and triangles of the pools.
    const refs = bvh.nodeRefs;
    for (let node = 0; node < bvh.nodeCount; node++) {
      for (const offset of [3, 11]) {
        const at = node * BvhNodeFloats + offset;
        refs[at] += refs[at + 4] === 0 ? this._nodeStart : this._triangleStart;
      }
    }
    this.root = {
      ref:
        bvh.root.ref +
        (bvh.root.count === 0 ? this._nodeStart : this._triangleStart),
      count: bvh.root.count,
    };
    if (bvh.nodeCount > 0) {
      pools.nodes.write(this._nodeStart, bvh.nodes);
    }
    if (bvh.triangleCount > 0) {
      pools.triangles.write(this._triangleStart, bvh.triangles);
    }
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    // Rewritten only by later queue writes: the commands submitted before
    // still read it.
    this.pools.nodes.release(this._nodeStart, this._nodeCount);
    this.pools.triangles.release(this._triangleStart, this.triangleCount);
  }
}

export class SoftwareTopLevel implements GpuTopLevel {
  readonly label?: string;
  private _buffer: GPUBuffer;
  private _capacity: number;
  private _generation = 0;
  private _instanceCount = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly pools: SoftwareBvhPools,
    { capacity = 64, label }: TopLevelDescriptor = {},
  ) {
    this.label = label;
    this._capacity = this.vec4sFor(Math.max(1, capacity));
    this._buffer = this.createBuffer(this._capacity);
    // An empty scene: a header with no instance.
    this.device.queue.writeBuffer(this._buffer, 0, new Uint32Array(4));
  }

  get instanceCount(): number {
    return this._instanceCount;
  }

  get version(): number {
    return this._generation + this.pools.generation;
  }

  /** The buffers of the binding: the top level, the nodes, the triangles. */
  get buffers(): readonly [GPUBuffer, GPUBuffer, GPUBuffer] {
    return [this._buffer, this.pools.nodes.buffer, this.pools.triangles.buffer];
  }

  // The vec4 of a top level of n instances, at most: the header, n - 1
  // nodes, the instances.
  private vec4sFor(n: number): number {
    return 1 + Math.max(0, n - 1) * 4 + n * InstanceVec4s;
  }

  private createBuffer(vec4s: number): GPUBuffer {
    return this.device.createBuffer({
      label: this.label ?? 'top level',
      size: vec4s * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  update(instances: readonly TopLevelInstance[]): void {
    const bottoms = instances.map((instance) => {
      if (
        !(instance.bottom instanceof SoftwareBottomLevel) ||
        instance.bottom.destroyed
      ) {
        throw new Error(
          'A bottom level of the instances was not created by the WebGPU backend, or was destroyed',
        );
      }
      return instance.bottom;
    });
    const count = instances.length;
    const boxes = new Float32Array(count * 6);
    instances.forEach((instance, i) =>
      transformBox(instance.transform, bottoms[i].bounds, boxes, i * 6),
    );
    const bvh = buildBvh(boxes, { maxLeafSize: 2 });
    const instanceBase = 1 + bvh.nodeCount * 4;
    const vec4s = instanceBase + count * InstanceVec4s;
    const data = new ArrayBuffer(vec4s * 16);
    const floats = new Float32Array(data);
    const words = new Uint32Array(data);
    words.set([bvh.root.ref, bvh.root.count, instanceBase, count]);
    floats.set(bvh.nodes.subarray(0, bvh.nodeCount * BvhNodeFloats), 4);
    const inverse = new Float64Array(16);
    for (let k = 0; k < count; k++) {
      const index = bvh.order[k];
      const instance = instances[index];
      invertAffine(instance.transform, inverse);
      const at = (instanceBase + k * InstanceVec4s) * 4;
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 4; column++) {
          floats[at + row * 4 + column] = inverse[column * 4 + row];
        }
      }
      const root = bottoms[index].root;
      words.set(
        [root.ref, root.count, (instance.mask ?? 0xff) & 0xff, index],
        at + 12,
      );
    }
    if (vec4s > this._capacity) {
      this._buffer.destroy();
      this._capacity = Math.max(vec4s, this._capacity * 2);
      this._buffer = this.createBuffer(this._capacity);
      this._generation++;
    }
    this.device.queue.writeBuffer(this._buffer, 0, data);
    this._instanceCount = count;
  }

  destroy(): void {
    this._buffer.destroy();
  }
}

/** The acceleration structures of a WebGPU device. */
export class SoftwareAccelerationStructures {
  private readonly _pools: SoftwareBvhPools;

  constructor(private readonly device: GPUDevice) {
    this._pools = new SoftwareBvhPools(device);
  }

  createBottomLevel(descriptor: BottomLevelDescriptor): SoftwareBottomLevel {
    return new SoftwareBottomLevel(this._pools, descriptor);
  }

  createTopLevel(descriptor?: TopLevelDescriptor): SoftwareTopLevel {
    return new SoftwareTopLevel(this.device, this._pools, descriptor);
  }

  destroy(): void {
    this._pools.destroy();
  }
}
