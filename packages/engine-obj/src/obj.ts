import {
  defaultPbrMaterial,
  MaterialDataType,
  MeshDataType,
  ModelDataType,
  type MaterialData,
  type MeshData,
  type ModelData,
  type ModelMeshData,
  type ModelNodeData,
} from '@fdw/engine-assets';
import type { MeshAttributeDescription } from '@fdw/engine-backend';
import {
  extname,
  type LoadContext,
  type ResourceLoader,
} from '@fdw/engine-resources';
import { MtlType, type MtlLibrary } from './mtl';

export interface ObjOptions {
  /**
   * OBJ puts v = 0 at the bottom of the images, the engine at the top: the
   * v coordinates are flipped (1 - v). True by default.
   */
  readonly flipV?: boolean;
  /** Receives the warnings (an unknown statement, a missing MTL file). */
  readonly warn?: (message: string) => void;
}

/** A mesh of the file: an object or group, its faces by material. */
export interface ObjGroup {
  readonly name: string;
  /** By material name (`''` without `usemtl`), the geometry of its faces. */
  readonly primitives: ReadonlyMap<string, MeshData>;
}

export interface ParsedObj {
  readonly groups: readonly ObjGroup[];
  readonly mtllibs: readonly string[];
}

class Builder {
  // Corner key → index of the vertex.
  private readonly index = new Map<string, number>();
  readonly corners: number[] = []; // the v, vt, vn indices of each vertex
  readonly indices: number[] = [];

  add(v: number, vt: number, vn: number): void {
    const key = `${v}/${vt}/${vn}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.corners.length / 3;
      this.index.set(key, i);
      this.corners.push(v, vt, vn);
    }
    this.indices.push(i);
  }
}

/**
 * Parses an OBJ file into typed arrays: one `MeshData` per material of each
 * object (`o`) or group (`g`). Polygons are split in fans of triangles,
 * negative indices count from the end, normals are computed (smooth) when the
 * file has none. Points and lines are skipped.
 */
export function parseObj(
  text: string,
  { flipV = true, warn = () => undefined }: ObjOptions = {}
): ParsedObj {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const mtllibs: string[] = [];
  const order: Array<{ name: string; materials: Map<string, Builder> }> = [];
  let group: (typeof order)[number] | undefined;
  let material = '';
  const builder = () => {
    if (!group) order.push((group = { name: 'default', materials: new Map() }));
    let b = group.materials.get(material);
    if (!b) group.materials.set(material, (b = new Builder()));
    return b;
  };
  const warned = new Set<string>();

  const lines = text.split(/\r?\n/);
  for (let l = 0; l < lines.length; l++) {
    let line = lines[l];
    // A trailing backslash continues the line.
    while (line.endsWith('\\') && l + 1 < lines.length)
      line = line.slice(0, -1) + ' ' + lines[++l];
    line = line.trim();
    if (line === '' || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'v':
        positions.push(+parts[1], +parts[2], +parts[3]);
        break;
      case 'vt':
        uvs.push(+parts[1], flipV ? 1 - +(parts[2] ?? 0) : +(parts[2] ?? 0));
        break;
      case 'vn':
        normals.push(+parts[1], +parts[2], +parts[3]);
        break;
      case 'f': {
        const b = builder();
        const corners = parts.slice(1).map((corner) => {
          const [v, vt, vn] = corner.split('/');
          // 1-based, negative from the end; -1 for none.
          const at = (text: string | undefined, count: number) => {
            if (!text) return -1;
            const n = parseInt(text, 10);
            return n < 0 ? count + n : n - 1;
          };
          return [
            at(v, positions.length / 3),
            at(vt, uvs.length / 2),
            at(vn, normals.length / 3),
          ] as const;
        });
        for (let i = 1; i + 1 < corners.length; i++) {
          for (const c of [corners[0], corners[i], corners[i + 1]])
            b.add(c[0], c[1], c[2]);
        }
        break;
      }
      case 'o':
      case 'g':
        order.push(
          (group = {
            name: parts.slice(1).join(' ') || 'default',
            materials: new Map(),
          })
        );
        break;
      case 'usemtl':
        material = parts.slice(1).join(' ');
        break;
      case 'mtllib':
        mtllibs.push(parts.slice(1).join(' '));
        break;
      case 's':
      case 'p':
      case 'l':
        break;
      default:
        if (!warned.has(parts[0])) {
          warned.add(parts[0]);
          warn(`OBJ: ${parts[0]} is not supported`);
        }
    }
  }

  const hasUv = uvs.length > 0;
  const groups: ObjGroup[] = [];
  for (const { name, materials } of order) {
    const primitives = new Map<string, MeshData>();
    for (const [mtl, b] of materials) {
      if (b.indices.length === 0) continue;
      primitives.set(
        mtl,
        meshOf(
          `${name}${mtl ? ` (${mtl})` : ''}`,
          b,
          positions,
          uvs,
          normals,
          hasUv
        )
      );
    }
    if (primitives.size > 0) groups.push({ name, primitives });
  }
  return { groups, mtllibs };
}

function meshOf(
  name: string,
  b: Builder,
  positions: readonly number[],
  uvs: readonly number[],
  normals: readonly number[],
  hasUv: boolean
): MeshData {
  const count = b.corners.length / 3;
  const floats = hasUv ? 8 : 6;
  const data = new Float32Array(count * floats);
  let missingNormals = false;
  for (let i = 0; i < count; i++) {
    const [v, vt, vn] = [
      b.corners[i * 3],
      b.corners[i * 3 + 1],
      b.corners[i * 3 + 2],
    ];
    const o = i * floats;
    data[o] = positions[v * 3];
    data[o + 1] = positions[v * 3 + 1];
    data[o + 2] = positions[v * 3 + 2];
    if (vn >= 0) {
      data[o + 3] = normals[vn * 3];
      data[o + 4] = normals[vn * 3 + 1];
      data[o + 5] = normals[vn * 3 + 2];
    } else missingNormals = true;
    if (hasUv && vt >= 0) {
      data[o + 6] = uvs[vt * 2];
      data[o + 7] = uvs[vt * 2 + 1];
    }
  }
  const indices =
    count > 0xffff ? new Uint32Array(b.indices) : new Uint16Array(b.indices);
  if (missingNormals) smoothNormals(data, floats, indices);
  const attributes: MeshAttributeDescription[] = [
    { semantic: 'position', format: 'float32x3', offset: 0 },
    { semantic: 'normal', format: 'float32x3', offset: 12 },
  ];
  if (hasUv)
    attributes.push({ semantic: 'uv', format: 'float32x2', offset: 24 });
  return {
    name,
    description: {
      vertexBuffers: [{ stride: floats * 4, stepMode: 'vertex', attributes }],
      vertexCount: count,
      indexBuffer: {
        format: indices instanceof Uint32Array ? 'uint32' : 'uint16',
        count: indices.length,
      },
    },
    vertices: [data],
    indices,
  };
}

/** The normals of the vertices without one: the sum of the faces around them, area weighted. */
function smoothNormals(
  data: Float32Array,
  floats: number,
  indices: ArrayLike<number>
): void {
  const count = data.length / floats;
  const sums = new Float32Array(count * 3);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [
      indices[t] * floats,
      indices[t + 1] * floats,
      indices[t + 2] * floats,
    ];
    const e1 = [
      data[b] - data[a],
      data[b + 1] - data[a + 1],
      data[b + 2] - data[a + 2],
    ];
    const e2 = [
      data[c] - data[a],
      data[c + 1] - data[a + 1],
      data[c + 2] - data[a + 2],
    ];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    for (const v of [indices[t], indices[t + 1], indices[t + 2]]) {
      sums[v * 3] += n[0];
      sums[v * 3 + 1] += n[1];
      sums[v * 3 + 2] += n[2];
    }
  }
  for (let i = 0; i < count; i++) {
    const o = i * floats;
    if (data[o + 3] !== 0 || data[o + 4] !== 0 || data[o + 5] !== 0) continue;
    const length =
      Math.hypot(sums[i * 3], sums[i * 3 + 1], sums[i * 3 + 2]) || 1;
    data[o + 3] = sums[i * 3] / length;
    data[o + 4] = sums[i * 3 + 1] / length;
    data[o + 5] = sums[i * 3 + 2] / length;
  }
}

const idOf = (name: string) => name.replace(/[/#]/g, '_');

/**
 * Builds the `ModelData` of a parsed file in a loader: a node per object or
 * group, a primitive per material. The meshes and materials are provided as
 * sub-resources: `mesh/<group>/<material index>`, `material/<name>`.
 */
export async function objModel(
  ctx: LoadContext<unknown>,
  parsed: ParsedObj,
  warn: (message: string) => void
): Promise<ModelData> {
  const libraries: MtlLibrary[] = [];
  for (const lib of parsed.mtllibs) {
    try {
      libraries.push(await ctx.use(MtlType, ctx.resolve(lib)).ready);
    } catch (e) {
      warn(
        `${ctx.uri}: ${lib} cannot be read, default materials (${
          (e as Error).message
        })`
      );
    }
  }
  const provided = new Set<string>();
  const materialId = (name: string): string => {
    const id = `material/${idOf(name || 'default')}`;
    if (!provided.has(id)) {
      provided.add(id);
      const data: MaterialData | undefined = libraries
        .map((l) => l.get(name))
        .find((m) => m !== undefined);
      if (!data && name) warn(`${ctx.uri}: material ${name} is not defined`);
      ctx.provide(MaterialDataType, id, data ?? defaultPbrMaterial);
    }
    return id;
  };

  const nodes: ModelNodeData[] = [];
  const meshes: ModelMeshData[] = [];
  const names = new Map<string, number>();
  for (const group of parsed.groups) {
    // Groups may share a name: the ids stay unique.
    const seen = names.get(group.name) ?? 0;
    names.set(group.name, seen + 1);
    const key = idOf(seen ? `${group.name}.${seen}` : group.name);
    let p = 0;
    const primitives = [...group.primitives].map(([mtl, data]) => {
      const mesh = `mesh/${key}/${p++}`;
      ctx.provide(MeshDataType, mesh, data);
      return { mesh, material: materialId(mtl) };
    });
    nodes.push({ name: group.name, children: [], mesh: meshes.length });
    meshes.push({ name: group.name, primitives });
  }
  const file = ctx.uri.split('#', 1)[0];
  return {
    name: file
      .slice(file.lastIndexOf('/') + 1)
      .replace(/\.obj$/i, '')
      .replace(/^.*:/, ''),
    nodes,
    roots: nodes.map((_, i) => i),
    meshes,
    skins: [],
    animations: [],
    cameras: [],
    lights: [],
  };
}

/** The loader of OBJ files, a `ModelDataType`; its MTL files are dependencies. */
export function objLoader(options: ObjOptions = {}): ResourceLoader<ModelData> {
  const warn = options.warn ?? ((message) => console.warn(`[obj] ${message}`));
  return {
    type: ModelDataType,
    extensions: ['obj'],
    async load(ctx) {
      if (extname(ctx.uri) !== 'obj') warn(`${ctx.uri} is read as an OBJ file`);
      return objModel(
        ctx,
        parseObj(await ctx.text(), { ...options, warn }),
        warn
      );
    },
  };
}
