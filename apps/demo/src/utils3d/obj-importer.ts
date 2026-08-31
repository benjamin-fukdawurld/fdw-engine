import { type ParseOpts, parseOBJFromString } from '@thi.ng/geom-io-obj';
import { BinaryData, binaryToString } from './utils';
import { MtlMaterial, parseMtl } from './mtl-parser';

export interface MeshData {
  vertices: number[];
  indices: number[];
  interleaved: boolean;
  hasUVs: boolean;
  hasNormals: boolean;
  stride: number;
  material?: MtlMaterial;
}

export type DataInput = BinaryData | string;

export type ImporterOptions = {
  interleaved?: boolean;
};

export type IImporter = {
  parse: (data: DataInput, options: ImporterOptions) => Promise<MeshData[]>;
  load: (
    src: RequestInfo | URL,
    options?: ImporterOptions
  ) => Promise<MeshData[]>;
};

export type ObjImporterOptions = Partial<ParseOpts> & ImporterOptions;

type Vertex = {
  v: number[];
  n?: number[];
  uv?: number[];
};

async function parseObjString(
  src: DataInput,
  opts?: ObjImporterOptions
): Promise<MeshData[]> {
  const str = typeof src === 'string' ? src : await binaryToString(src);
  const model = await parseOBJFromString(str, opts);
  const materials = (
    await Promise.all(model.mtlLibs.map(async (mtlFile) => parseMtl(mtlFile)))
  ).flat();

  const meshes: MeshData[] = [];

  for (const object of model.objects) {
    for (const group of object.groups) {
      const faces = group.faces;
      const dedupVertexIndexMap = new Map<string, number>();
      const internalVertices: Vertex[] = [];
      const indices: number[] = [];
      const hasUVs = model.uvs.length > 0;
      const hasNormals = model.normals.length > 0;
      const stride = 3 + (hasUVs ? 2 : 0) + (hasNormals ? 3 : 0);
      const interleaved = opts?.interleaved === false ? false : true;

      faces.forEach((face) => {
        const keys = [`${face.v[0]}`, `${face.v[1]}`, `${face.v[2]}`];
        const values: Vertex[] = [
          { v: [...model.vertices[face.v[0]]] },
          { v: [...model.vertices[face.v[1]]] },
          { v: [...model.vertices[face.v[2]]] },
        ];
        if (face.n) {
          keys[0] += `_${face.n[0]}`;
          keys[1] += `_${face.n[1]}`;
          keys[2] += `_${face.n[2]}`;

          values[0].n = [...model.normals[face.n[0]]];
          values[1].n = [...model.normals[face.n[1]]];
          values[2].n = [...model.normals[face.n[2]]];
        }
        if (face.uv) {
          keys[0] += `_${face.uv[0]}`;
          keys[1] += `_${face.uv[1]}`;
          keys[2] += `_${face.uv[2]}`;
          values[0].uv = [...model.uvs[face.uv[0]]];
          values[1].uv = [...model.uvs[face.uv[1]]];
          values[2].uv = [...model.uvs[face.uv[2]]];
        }
        keys.forEach((key, i) => {
          if (!dedupVertexIndexMap.has(key)) {
            dedupVertexIndexMap.set(key, internalVertices.length);
            internalVertices.push(values[i]);
          }
          indices.push(dedupVertexIndexMap.get(key)!);
        });
      });

      const vertices: number[] = [];
      if (interleaved) {
        internalVertices.forEach((vertex) => {
          vertices.push(...vertex.v);
          if (hasNormals && vertex.n) {
            vertices.push(...vertex.n);
          }
          if (hasUVs && vertex.uv) {
            vertices.push(...vertex.uv);
          }
        });
      } else {
        internalVertices.forEach((vertex) => {
          vertices.push(...vertex.v);
        });
        if (hasNormals) {
          internalVertices.forEach((vertex) => {
            vertices.push(...vertex.n!);
          });
        }
        if (hasUVs) {
          internalVertices.forEach((vertex) => {
            vertices.push(...vertex.uv!);
          });
        }
      }

      meshes.push({
        vertices: vertices.flat(),
        indices,
        interleaved,
        hasUVs,
        hasNormals,
        stride,
        material: group.mtl
          ? materials.find((m) => m.name === group.mtl)
          : undefined,
      });
    }
  }

  return meshes.filter(
    (mesh) => mesh.vertices.length > 0 && mesh.indices.length > 0
  );
}

async function loadObjFile(
  input: RequestInfo | URL,
  opts?: ObjImporterOptions
): Promise<MeshData[]> {
  const str = await fetch(input).then((response) => response.text());
  return parseObjString(str, opts);
}

export const ObjImporter: IImporter = {
  parse: parseObjString,
  load: loadObjFile,
};
