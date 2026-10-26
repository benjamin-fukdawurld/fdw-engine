import { Mesh } from '@fdw/engine-core';
import { MaxLevel, Patches, TexelsPerPatch } from './patches';

/** The displacement of a patch mesh, as patchVertex displaces on the GPU. */
export interface PatchMeshDisplacement {
  /** The height at a uv, as the GPU samples its height map. */
  readonly height: (u: number, v: number) => number;
  readonly scale?: number;
  readonly bias?: number;
  /** The step of the finite differences of the normals, in uv (1 / 256). */
  readonly texel?: number;
}

/**
 * The mesh of a patch surface at one level (2^level quads along each edge
 * of each patch), displaced along the normals of the patches as
 * patchVertex does with its height map: positions, normals and uvs. What
 * the rays see of the surface (its rayMesh), since its geometry is made in
 * the vertex stage.
 */
export function patchMesh(
  patches: Patches,
  {
    level = 3,
    displacement,
    label = 'patch mesh',
  }: {
    level?: number;
    displacement?: PatchMeshDisplacement;
    label?: string;
  } = {},
): Mesh {
  if (level < 0 || level > MaxLevel) {
    throw new Error(`The levels of a patch mesh go from 0 to ${MaxLevel}`);
  }
  const n = 1 << level;
  const side = n + 1;
  const vertexCount = patches.count * side * side;
  const vertices = new Float32Array(vertexCount * 8);
  const indices = new Uint32Array(patches.count * n * n * 6);
  const scale = displacement?.scale ?? 0.1;
  const bias = displacement?.bias ?? 0;
  const step = displacement?.texel ?? 1 / 256;
  const lerp = (a: number, b: number, w: number) => a * (1 - w) + b * w;
  let vertex = 0;
  let index = 0;
  for (let patch = 0; patch < patches.count; patch++) {
    const texel = (k: number) =>
      patches.data.subarray(
        (patch * TexelsPerPatch + k) * 4,
        (patch * TexelsPerPatch + k) * 4 + 4,
      );
    const corners = [0, 1, 2, 3].map((c) => ({
      position: texel(c),
      normal: texel(c + 4),
    }));
    const bilinear = (value: (c: number) => number, s: number, t: number) =>
      lerp(lerp(value(0), value(1), s), lerp(value(2), value(3), s), t);
    const first = vertex;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        const t = j / n;
        const at = (k: number) => bilinear((c) => corners[c].position[k], s, t);
        const base = [at(0), at(1), at(2)];
        const u = bilinear((c) => corners[c].position[3], s, t);
        const v = bilinear((c) => corners[c].normal[3], s, t);
        const raw = [0, 1, 2].map((k) =>
          bilinear((c) => corners[c].normal[k], s, t),
        );
        const length = Math.hypot(raw[0], raw[1], raw[2]) || 1;
        const baseNormal = raw.map((x) => x / length);
        let position = base;
        let normal = baseNormal;
        if (displacement) {
          const h = displacement.height;
          position = base.map(
            (x, k) => x + baseNormal[k] * (h(u, v) + bias) * scale,
          );
          // The slope of the height along u and v, then along s and t.
          const slope = [
            (h(u + step, v) - h(u - step, v)) / (2 * step),
            (h(u, v + step) - h(u, v - step)) / (2 * step),
          ];
          const p = (c: number) => [0, 1, 2].map((k) => corners[c].position[k]);
          const uv = (c: number) => [
            corners[c].position[3],
            corners[c].normal[3],
          ];
          const minus = (a: number[], b: number[]) => a.map((x, k) => x - b[k]);
          const mix = (a: number[], b: number[], w: number) =>
            a.map((x, k) => lerp(x, b[k], w));
          const alongS = mix(minus(p(1), p(0)), minus(p(3), p(2)), t);
          const alongT = mix(minus(p(2), p(0)), minus(p(3), p(1)), s);
          const uvS = mix(minus(uv(1), uv(0)), minus(uv(3), uv(2)), t);
          const uvT = mix(minus(uv(2), uv(0)), minus(uv(3), uv(1)), s);
          const tangent = (along: number[], uvAlong: number[]) => {
            const rise =
              (slope[0] * uvAlong[0] + slope[1] * uvAlong[1]) * scale;
            return along.map((x, k) => x + baseNormal[k] * rise);
          };
          const a = tangent(alongT, uvT);
          const b = tangent(alongS, uvS);
          const cross = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
          ];
          const size = Math.hypot(cross[0], cross[1], cross[2]) || 1;
          normal = cross.map((x) => x / size);
        }
        vertices.set([...position, ...normal, u, v], vertex * 8);
        vertex++;
      }
    }
    // Two triangles a quad, their front on the side of the normal.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c00 = first + j * side + i;
        const c10 = c00 + 1;
        const c01 = c00 + side;
        const c11 = c01 + 1;
        indices.set([c00, c01, c10, c10, c01, c11], index);
        index += 6;
      }
    }
  }
  return new Mesh({
    description: {
      vertexBuffers: [
        {
          stride: 32,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
            { semantic: 'normal', format: 'float32x3', offset: 12 },
            { semantic: 'uv', format: 'float32x2', offset: 24 },
          ],
        },
      ],
      vertexCount,
      indexBuffer: { format: 'uint32', count: indices.length },
    },
    vertices: [vertices],
    indices,
    label,
  });
}
