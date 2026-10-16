import type { GpuBuffer, RenderBackend } from '@fdw/engine-backend';
import type { Mesh } from '@fdw/engine-core';
import { hasAttribute, readAttribute } from './attributes';
import { skinStride, type SkinnedAttributes } from './graph';

/**
 * The skinning data of a mesh, read once from its vertices and shared by
 * all its instances: the joints and the weights of each vertex, its rest
 * position, normal and tangent, and the GPU buffers of the compute
 * skinning (created on first use, per backend).
 */
export class MeshSkin {
  private static readonly _cache = new WeakMap<Mesh, MeshSkin>();

  readonly attributes: SkinnedAttributes;
  readonly vertexCount: number;
  /** 4 joints a vertex: indices in the joints of the skin. */
  readonly joints: Uint32Array<ArrayBuffer>;
  /** 4 weights a vertex, normalized to a sum of 1. */
  readonly weights: Float32Array<ArrayBuffer>;
  /** The rest vertices, `stride` vec4 a vertex (see SkinValues.rest). */
  readonly rest: Float32Array<ArrayBuffer>;
  private readonly _buffers = new WeakMap<
    RenderBackend,
    { rest: GpuBuffer; joints: GpuBuffer; weights: GpuBuffer }
  >();
  private readonly _radii = new WeakMap<Float32Array, Float32Array>();

  /**
   * @throws when the mesh has no `joints`, `weights` or `position`
   * attribute.
   */
  constructor(readonly mesh: Mesh) {
    const joints = readAttribute(mesh, 'joints', 4);
    const weights = readAttribute(mesh, 'weights', 4);
    const positions = readAttribute(mesh, 'position', 3);
    if (!joints || !weights || !positions) {
      throw new Error(
        `The mesh "${mesh.label ?? ''}" needs joints, weights and positions to be skinned`,
      );
    }
    this.attributes = {
      normal: hasAttribute(mesh, 'normal'),
      tangent: hasAttribute(mesh, 'tangent'),
    };
    const count = mesh.description.vertexCount;
    this.vertexCount = count;
    this.joints = Uint32Array.from(joints);
    // The weights of glTF sum to 1, up to their quantization.
    this.weights = weights;
    for (let v = 0; v < count; v++) {
      const i = v * 4;
      const sum = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
      if (sum > 0) {
        for (let k = 0; k < 4; k++) weights[i + k] /= sum;
      } else {
        weights[i] = 1;
      }
    }
    const stride = skinStride(this.attributes);
    const rest = new Float32Array(count * stride * 4);
    const normals = this.attributes.normal
      ? readAttribute(mesh, 'normal', 3)
      : undefined;
    const tangents = this.attributes.tangent
      ? readAttribute(mesh, 'tangent', 4)
      : undefined;
    for (let v = 0; v < count; v++) {
      let o = v * stride * 4;
      rest.set(positions.subarray(v * 3, v * 3 + 3), o);
      rest[o + 3] = 1;
      if (normals) {
        o += 4;
        rest.set(normals.subarray(v * 3, v * 3 + 3), o);
      }
      if (tangents) {
        o += 4;
        rest.set(tangents.subarray(v * 4, v * 4 + 4), o);
      }
    }
    this.rest = rest;
  }

  /** The skinning data of a mesh, read once. */
  static of(mesh: Mesh): MeshSkin {
    let skin = MeshSkin._cache.get(mesh);
    if (!skin) {
      skin = new MeshSkin(mesh);
      MeshSkin._cache.set(mesh, skin);
    }
    return skin;
  }

  /** The vec4 a vertex of the compute buffers. */
  get stride(): number {
    return skinStride(this.attributes);
  }

  /**
   * The radius of each joint of a skin around this mesh: how far its
   * vertices are from the joint, in the bind pose (-1 for the joints that
   * move none). The joint is at the origin of its inverse bind matrix.
   */
  radii(inverseBindMatrices: Float32Array): Float32Array {
    let radii = this._radii.get(inverseBindMatrices);
    if (radii) {
      return radii;
    }
    const count = inverseBindMatrices.length / 16;
    const centers = bindCenters(inverseBindMatrices);
    radii = new Float32Array(count).fill(-1);
    const { joints, weights, rest, stride } = this;
    for (let v = 0; v < this.vertexCount; v++) {
      const o = v * stride * 4;
      for (let k = 0; k < 4; k++) {
        if (weights[v * 4 + k] <= 0) continue;
        const j = joints[v * 4 + k];
        if (j >= count) {
          throw new Error(
            `A vertex of "${this.mesh.label ?? ''}" has joint ${j}, the skin has ${count}`,
          );
        }
        const d = Math.hypot(
          rest[o] - centers[j * 3],
          rest[o + 1] - centers[j * 3 + 1],
          rest[o + 2] - centers[j * 3 + 2],
        );
        radii[j] = Math.max(radii[j], d);
      }
    }
    this._radii.set(inverseBindMatrices, radii);
    return radii;
  }

  /** The buffers of the compute skinning on a backend, created once. */
  buffers(backend: RenderBackend): {
    rest: GpuBuffer;
    joints: GpuBuffer;
    weights: GpuBuffer;
  } {
    let buffers = this._buffers.get(backend);
    if (!buffers) {
      const create = (label: string, data: ArrayBufferView<ArrayBuffer>) =>
        backend.buffers.create({
          label: `${this.mesh.label ?? 'mesh'} ${label}`,
          size: Math.max(data.byteLength, 16),
          usage: ['storage', 'copy-dst'],
          initialData: data,
        });
      buffers = {
        rest: create('rest vertices', this.rest),
        joints: create('joints', this.joints),
        weights: create('weights', this.weights),
      };
      this._buffers.set(backend, buffers);
      this.mesh.onDestroy(() => {
        buffers?.rest.destroy();
        buffers?.joints.destroy();
        buffers?.weights.destroy();
      });
    }
    return buffers;
  }
}

/**
 * The joints of a skin in the bind pose: the point each inverse bind matrix
 * maps to the origin, 3 numbers a joint.
 */
export function bindCenters(inverseBindMatrices: Float32Array): Float64Array {
  const count = inverseBindMatrices.length / 16;
  const centers = new Float64Array(count * 3);
  for (let j = 0; j < count; j++) {
    centers.set(
      bindCenter(inverseBindMatrices.subarray(j * 16, j * 16 + 16)),
      j * 3,
    );
  }
  return centers;
}

// The point the matrix maps to the origin: m⁻¹ × (0, 0, 0, 1), from the
// 3 × 3 part and the translation (Cramer's rule).
function bindCenter(m: ArrayLike<number>): [number, number, number] {
  const [a, b, c] = [m[0], m[1], m[2]];
  const [d, e, f] = [m[4], m[5], m[6]];
  const [g, h, i] = [m[8], m[9], m[10]];
  const [tx, ty, tz] = [-m[12], -m[13], -m[14]];
  // Columns (a b c), (d e f), (g h i): solve M x = −t.
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  if (Math.abs(det) < 1e-12) {
    return [0, 0, 0];
  }
  const x =
    (tx * (e * i - f * h) - d * (ty * i - tz * h) + g * (ty * f - tz * e)) /
    det;
  const y =
    (a * (ty * i - tz * h) - tx * (b * i - c * h) + g * (b * tz - c * ty)) /
    det;
  const z =
    (a * (e * tz - f * ty) - d * (b * tz - c * ty) + tx * (b * f - c * e)) /
    det;
  return [x, y, z];
}

/**
 * Skins the positions of a mesh on the CPU, with the joint matrices of a
 * skin (column-major, 16 numbers a joint): the reference of the GPU
 * paths, and what a raycast against a character can test.
 */
export function skinPositions(
  skin: MeshSkin,
  matrices: ArrayLike<number>,
  out = new Float32Array(skin.vertexCount * 3),
): Float32Array {
  const { joints, weights, rest, stride } = skin;
  for (let v = 0; v < skin.vertexCount; v++) {
    const o = v * stride * 4;
    const [x, y, z] = [rest[o], rest[o + 1], rest[o + 2]];
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k];
      if (w === 0) continue;
      const m = joints[v * 4 + k] * 16;
      px +=
        w *
        (matrices[m] * x +
          matrices[m + 4] * y +
          matrices[m + 8] * z +
          matrices[m + 12]);
      py +=
        w *
        (matrices[m + 1] * x +
          matrices[m + 5] * y +
          matrices[m + 9] * z +
          matrices[m + 13]);
      pz +=
        w *
        (matrices[m + 2] * x +
          matrices[m + 6] * y +
          matrices[m + 10] * z +
          matrices[m + 14]);
    }
    out[v * 3] = px;
    out[v * 3 + 1] = py;
    out[v * 3 + 2] = pz;
  }
  return out;
}
