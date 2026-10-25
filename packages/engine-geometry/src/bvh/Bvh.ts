// A bounding volume hierarchy over primitives given by their boxes, built
// with the surface area heuristic (binned): what the rays traverse, on the
// CPU and on the GPU (the software ray tracing of WebGPU). The nodes are
// laid out for the GPU: each holds the boxes of its two children, so that a
// traversal tests both at once and visits the nearest first.

/** Floats per node: the boxes of the two children, and their references. */
export const BvhNodeFloats = 16;

/**
 * A reference to a child of a node, or to the root: a node (count 0) or a
 * leaf of `count` primitives, from `ref` in the order of the leaves.
 */
export interface BvhRef {
  readonly ref: number;
  readonly count: number;
}

/**
 * A BVH. Each node takes 16 floats: for the left then the right child, its
 * box (min xyz, then max xyz) with, in the 4th and 8th floats, the bits of
 * two u32: the reference of the child (a node, or the first primitive of a
 * leaf) and its number of primitives (0 for a node). The primitives of the
 * leaves are in `order`: a leaf of `count` primitives from `ref` holds
 * order[ref] … order[ref + count - 1].
 */
export interface Bvh {
  /** The nodes: 16 floats each (see {@link Bvh}). */
  readonly nodes: Float32Array<ArrayBuffer>;
  /** The same memory as u32: the references and counts. */
  readonly nodeRefs: Uint32Array<ArrayBuffer>;
  readonly nodeCount: number;
  /** The root: a node, or a single leaf for a few primitives. */
  readonly root: BvhRef;
  /** The primitives in the order of the leaves. */
  readonly order: Uint32Array<ArrayBuffer>;
  /** The box of all the primitives: min xyz, max xyz. */
  readonly bounds: Float32Array<ArrayBuffer>;
}

export interface BvhOptions {
  /** The most primitives in a leaf (default 4). */
  readonly maxLeafSize?: number;
  /** The bins of the SAH along each axis (default 12). */
  readonly bins?: number;
  /**
   * The cost of visiting a node, against that of testing a primitive (1):
   * higher values make shallower trees with larger leaves. Default 1.
   */
  readonly nodeCost?: number;
}

const area = (
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number => {
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx);
};

/**
 * Builds a BVH over primitives given by their boxes: 6 floats each (min
 * xyz, max xyz). A split is chosen among `bins` positions along each axis
 * of the centers, by the surface area heuristic; a range of at most
 * `maxLeafSize` primitives stays a leaf when splitting would not lower the
 * cost.
 */
export function buildBvh(
  boxes: ArrayLike<number>,
  options: BvhOptions = {},
): Bvh {
  const maxLeafSize = Math.max(1, options.maxLeafSize ?? 4);
  const binCount = Math.max(2, options.bins ?? 12);
  const nodeCost = options.nodeCost ?? 1;
  const count = Math.floor(boxes.length / 6);
  const order = new Uint32Array(count);
  const centers = new Float32Array(count * 3);
  const bounds = new Float32Array([
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ]);
  for (let i = 0; i < count; i++) {
    order[i] = i;
    for (let axis = 0; axis < 3; axis++) {
      const min = boxes[i * 6 + axis];
      const max = boxes[i * 6 + 3 + axis];
      centers[i * 3 + axis] = (min + max) / 2;
      bounds[axis] = Math.min(bounds[axis], min);
      bounds[3 + axis] = Math.max(bounds[3 + axis], max);
    }
  }

  // At most count - 1 nodes: each splits a range in two non-empty ones.
  const capacity = Math.max(1, count - 1);
  const buffer = new ArrayBuffer(capacity * BvhNodeFloats * 4);
  const nodes = new Float32Array(buffer);
  const nodeRefs = new Uint32Array(buffer);
  let nodeCount = 0;

  // Bins of one axis: their boxes and counts, then the costs of the
  // splits from the left and from the right.
  const binBoxes = new Float64Array(binCount * 6);
  const binCounts = new Uint32Array(binCount);
  const rightAreas = new Float64Array(binCount);
  const rightCounts = new Uint32Array(binCount);

  // The box of a range of primitives, into out (6 floats from offset).
  const rangeBox = (
    start: number,
    end: number,
    out: Float32Array,
    offset: number,
  ) => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const box = order[i] * 6;
      minX = Math.min(minX, boxes[box]);
      minY = Math.min(minY, boxes[box + 1]);
      minZ = Math.min(minZ, boxes[box + 2]);
      maxX = Math.max(maxX, boxes[box + 3]);
      maxY = Math.max(maxY, boxes[box + 4]);
      maxZ = Math.max(maxZ, boxes[box + 5]);
    }
    out[offset] = minX;
    out[offset + 1] = minY;
    out[offset + 2] = minZ;
    out[offset + 4] = maxX;
    out[offset + 5] = maxY;
    out[offset + 6] = maxZ;
  };

  // Where to split a range: the index of the first primitive of the right
  // part, after reordering, or -1 to keep a leaf.
  const split = (start: number, end: number): number => {
    const n = end - start;
    if (n <= 1) {
      return -1;
    }
    // The extent of the centers.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let boxMinX = Infinity;
    let boxMinY = Infinity;
    let boxMinZ = Infinity;
    let boxMaxX = -Infinity;
    let boxMaxY = -Infinity;
    let boxMaxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const c = order[i] * 3;
      minX = Math.min(minX, centers[c]);
      minY = Math.min(minY, centers[c + 1]);
      minZ = Math.min(minZ, centers[c + 2]);
      maxX = Math.max(maxX, centers[c]);
      maxY = Math.max(maxY, centers[c + 1]);
      maxZ = Math.max(maxZ, centers[c + 2]);
      const b = order[i] * 6;
      boxMinX = Math.min(boxMinX, boxes[b]);
      boxMinY = Math.min(boxMinY, boxes[b + 1]);
      boxMinZ = Math.min(boxMinZ, boxes[b + 2]);
      boxMaxX = Math.max(boxMaxX, boxes[b + 3]);
      boxMaxY = Math.max(boxMaxY, boxes[b + 4]);
      boxMaxZ = Math.max(boxMaxZ, boxes[b + 5]);
    }
    const parentArea = area(
      boxMinX,
      boxMinY,
      boxMinZ,
      boxMaxX,
      boxMaxY,
      boxMaxZ,
    );
    const centerMin = [minX, minY, minZ];
    const centerMax = [maxX, maxY, maxZ];

    let bestCost = Infinity;
    let bestAxis = -1;
    let bestBin = 0;
    for (let axis = 0; axis < 3; axis++) {
      const low = centerMin[axis];
      const extent = centerMax[axis] - low;
      if (!(extent > 0)) {
        continue;
      }
      const toBin = binCount / extent;
      binBoxes.fill(Infinity);
      for (let b = 0; b < binCount; b++) {
        binBoxes[b * 6 + 3] = -Infinity;
        binBoxes[b * 6 + 4] = -Infinity;
        binBoxes[b * 6 + 5] = -Infinity;
      }
      binCounts.fill(0);
      for (let i = start; i < end; i++) {
        const primitive = order[i];
        const bin = Math.min(
          binCount - 1,
          Math.floor((centers[primitive * 3 + axis] - low) * toBin),
        );
        binCounts[bin]++;
        const o = bin * 6;
        const p = primitive * 6;
        for (let k = 0; k < 3; k++) {
          binBoxes[o + k] = Math.min(binBoxes[o + k], boxes[p + k]);
          binBoxes[o + 3 + k] = Math.max(binBoxes[o + 3 + k], boxes[p + 3 + k]);
        }
      }
      // From the right: the area and count of the bins b … binCount - 1.
      let rMinX = Infinity;
      let rMinY = Infinity;
      let rMinZ = Infinity;
      let rMaxX = -Infinity;
      let rMaxY = -Infinity;
      let rMaxZ = -Infinity;
      let rCount = 0;
      for (let b = binCount - 1; b > 0; b--) {
        const o = b * 6;
        rMinX = Math.min(rMinX, binBoxes[o]);
        rMinY = Math.min(rMinY, binBoxes[o + 1]);
        rMinZ = Math.min(rMinZ, binBoxes[o + 2]);
        rMaxX = Math.max(rMaxX, binBoxes[o + 3]);
        rMaxY = Math.max(rMaxY, binBoxes[o + 4]);
        rMaxZ = Math.max(rMaxZ, binBoxes[o + 5]);
        rCount += binCounts[b];
        rightAreas[b] = area(rMinX, rMinY, rMinZ, rMaxX, rMaxY, rMaxZ);
        rightCounts[b] = rCount;
      }
      // From the left, each split between bin b - 1 and b.
      let lMinX = Infinity;
      let lMinY = Infinity;
      let lMinZ = Infinity;
      let lMaxX = -Infinity;
      let lMaxY = -Infinity;
      let lMaxZ = -Infinity;
      let lCount = 0;
      for (let b = 1; b < binCount; b++) {
        const o = (b - 1) * 6;
        lMinX = Math.min(lMinX, binBoxes[o]);
        lMinY = Math.min(lMinY, binBoxes[o + 1]);
        lMinZ = Math.min(lMinZ, binBoxes[o + 2]);
        lMaxX = Math.max(lMaxX, binBoxes[o + 3]);
        lMaxY = Math.max(lMaxY, binBoxes[o + 4]);
        lMaxZ = Math.max(lMaxZ, binBoxes[o + 5]);
        lCount += binCounts[b - 1];
        if (lCount === 0 || rightCounts[b] === 0) {
          continue;
        }
        const cost =
          lCount * area(lMinX, lMinY, lMinZ, lMaxX, lMaxY, lMaxZ) +
          rightCounts[b] * rightAreas[b];
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestBin = b;
        }
      }
    }

    const leafCost = n;
    const splitCost =
      parentArea > 0 ? nodeCost + bestCost / parentArea : Infinity;
    if (bestAxis < 0) {
      // All the centers at the same point: halves, if too many.
      return n > maxLeafSize ? start + (n >> 1) : -1;
    }
    if (n <= maxLeafSize && leafCost <= splitCost) {
      return -1;
    }
    // Partition the range by bin.
    const low = centerMin[bestAxis];
    const toBin = binCount / (centerMax[bestAxis] - low);
    let left = start;
    let right = end - 1;
    while (left <= right) {
      const primitive = order[left];
      const bin = Math.min(
        binCount - 1,
        Math.floor((centers[primitive * 3 + bestAxis] - low) * toBin),
      );
      if (bin < bestBin) {
        left++;
      } else {
        order[left] = order[right];
        order[right] = primitive;
        right--;
      }
    }
    return left > start && left < end ? left : start + (n >> 1);
  };

  // Builds the node of a range (split at `middle`), and its subtree;
  // returns its index. Iterative: a stack of the children left to build.
  const build = (start: number, middle: number, end: number): number => {
    const root = nodeCount++;
    const stack: number[] = [root, start, middle, end];
    while (stack.length > 0) {
      const rangeEnd = stack.pop() as number;
      const rangeMiddle = stack.pop() as number;
      const rangeStart = stack.pop() as number;
      const node = stack.pop() as number;
      const base = node * BvhNodeFloats;
      const children: [number, number, number][] = [
        [rangeStart, rangeMiddle, 0],
        [rangeMiddle, rangeEnd, 8],
      ];
      for (const [childStart, childEnd, offset] of children) {
        rangeBox(childStart, childEnd, nodes, base + offset);
        const at = split(childStart, childEnd);
        if (at < 0) {
          nodeRefs[base + offset + 3] = childStart;
          nodeRefs[base + offset + 7] = childEnd - childStart;
        } else {
          const child = nodeCount++;
          nodeRefs[base + offset + 3] = child;
          nodeRefs[base + offset + 7] = 0;
          stack.push(child, childStart, at, childEnd);
        }
      }
    }
    return root;
  };

  const rootSplit = split(0, count);
  const root: BvhRef =
    rootSplit < 0
      ? { ref: 0, count }
      : { ref: build(0, rootSplit, count), count: 0 };
  return {
    nodes,
    nodeRefs,
    nodeCount,
    root,
    order,
    bounds,
  };
}

/**
 * The distance along a ray (origin, inverse of its direction) where it
 * enters a box of 6 floats at `offset` (min xyz, then max xyz, 4 floats
 * apart), within [tMin, tMax]; Infinity when it misses it.
 */
export function rayBoxDistance(
  box: ArrayLike<number>,
  offset: number,
  ox: number,
  oy: number,
  oz: number,
  ix: number,
  iy: number,
  iz: number,
  tMin: number,
  tMax: number,
): number {
  const x0 = (box[offset] - ox) * ix;
  const x1 = (box[offset + 4] - ox) * ix;
  const y0 = (box[offset + 1] - oy) * iy;
  const y1 = (box[offset + 5] - oy) * iy;
  const z0 = (box[offset + 2] - oz) * iz;
  const z1 = (box[offset + 6] - oz) * iz;
  const near = Math.max(
    Math.min(x0, x1),
    Math.min(y0, y1),
    Math.min(z0, z1),
    tMin,
  );
  const far = Math.min(
    Math.max(x0, x1),
    Math.max(y0, y1),
    Math.max(z0, z1),
    tMax,
  );
  return near <= far ? near : Infinity;
}

/**
 * Visits the leaves of a BVH whose boxes a ray enters before `tMax()` (read
 * again after each leaf: the closest hit so far), the nearest first.
 * `leaf(first, count)` returns true to stop the traversal.
 */
export function traverseBvh(
  bvh: Bvh,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  tMin: number,
  tMax: () => number,
  leaf: (first: number, count: number) => boolean,
): void {
  const { root, nodes, nodeRefs } = bvh;
  if (root.count > 0) {
    leaf(root.ref, root.count);
    return;
  }
  if (bvh.nodeCount === 0) {
    return;
  }
  const [ox, oy, oz] = [origin[0], origin[1], origin[2]];
  const ix = 1 / direction[0];
  const iy = 1 / direction[1];
  const iz = 1 / direction[2];
  const stack: number[] = [];
  let node = root.ref;
  for (;;) {
    const base = node * BvhNodeFloats;
    let tLeft = rayBoxDistance(
      nodes,
      base,
      ox,
      oy,
      oz,
      ix,
      iy,
      iz,
      tMin,
      tMax(),
    );
    let tRight = rayBoxDistance(
      nodes,
      base + 8,
      ox,
      oy,
      oz,
      ix,
      iy,
      iz,
      tMin,
      tMax(),
    );
    // The leaves are tested at once; the nodes are visited next.
    const leftCount = nodeRefs[base + 7];
    const rightCount = nodeRefs[base + 15];
    if (tLeft < Infinity && leftCount > 0) {
      if (leaf(nodeRefs[base + 3], leftCount)) {
        return;
      }
      tLeft = Infinity;
    }
    if (tRight < Infinity && rightCount > 0) {
      if (leaf(nodeRefs[base + 11], rightCount)) {
        return;
      }
      tRight = Infinity;
    }
    if (tLeft < Infinity && tRight < Infinity) {
      const leftFirst = tLeft <= tRight;
      stack.push(nodeRefs[base + (leftFirst ? 11 : 3)]);
      node = nodeRefs[base + (leftFirst ? 3 : 11)];
    } else if (tLeft < Infinity) {
      node = nodeRefs[base + 3];
    } else if (tRight < Infinity) {
      node = nodeRefs[base + 11];
    } else if (stack.length > 0) {
      node = stack.pop() as number;
    } else {
      return;
    }
  }
}
