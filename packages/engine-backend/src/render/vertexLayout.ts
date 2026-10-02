import {
  ScalarType,
  ShaderType,
  typeToString,
  VectorType,
  VertexInputRequirement,
} from '@fdw/engine-shader';
import type {
  MeshBufferDescription,
  MeshDescription,
  VertexAttributeFormat,
} from '../mesh';

const scalarOf = (
  format: VertexAttributeFormat
): 'f32' | 'i32' | 'u32' | undefined => {
  if (/^(float|unorm|snorm)/.test(format)) {
    return 'f32';
  }
  if (format.startsWith('sint')) {
    return 'i32';
  }
  if (format.startsWith('uint')) {
    return 'u32';
  }
  return undefined;
};

// Number of components read from a vertex format: 'float32x3' → 3.
const componentsOf = (format: VertexAttributeFormat): number => {
  const match = /x(\d)$/.exec(format);
  return match ? Number(match[1]) : 1;
};

// Shader type read from a vertex attribute format. Normalized formats are
// read as floats.
export function vertexFormatShaderType(
  format: VertexAttributeFormat
): ScalarType | VectorType | undefined {
  const scalar = scalarOf(format);
  if (!scalar) {
    return undefined;
  }
  const components = componentsOf(format);
  return components === 1
    ? { kind: 'scalar', scalar }
    : { kind: 'vector', size: components as 2 | 3 | 4, scalar };
}

// Whether an attribute of the given format can feed a shader input. A vertex
// can provide more components than the shader reads (vec4 data for a vec3
// input), as in every graphics API.
export function isVertexFormatCompatible(
  format: VertexAttributeFormat,
  type: ShaderType
): boolean {
  const provided = vertexFormatShaderType(format);
  if (!provided || (type.kind !== 'scalar' && type.kind !== 'vector')) {
    return false;
  }
  if (provided.scalar !== type.scalar) {
    return false;
  }
  const wanted = type.kind === 'scalar' ? 1 : type.size;
  return componentsOf(format) >= wanted;
}

export interface VertexBufferLayout
  extends Omit<MeshBufferDescription, 'attributes'> {
  // Index of the mesh vertex buffer.
  readonly buffer: number;
  readonly attributes: readonly {
    readonly format: VertexAttributeFormat;
    readonly offset: number;
    readonly location: number;
  }[];
}

// Matches the inputs of a program with the attributes of a mesh, by
// semantic. Attributes the program does not read are left out; mesh buffers
// with no used attribute too. Throws when an input has no compatible
// attribute.
export function matchVertexLayout(
  inputs: readonly VertexInputRequirement[],
  mesh: MeshDescription
): VertexBufferLayout[] {
  const layouts = mesh.vertexBuffers.map((buffer, index) => ({
    buffer: index,
    stride: buffer.stride,
    stepMode: buffer.stepMode,
    attributes: [] as {
      format: VertexAttributeFormat;
      offset: number;
      location: number;
    }[],
  }));

  for (const input of inputs) {
    let found = false;
    mesh.vertexBuffers.forEach((buffer, index) => {
      const attribute = buffer.attributes.find(
        (candidate) => candidate.semantic === input.semantic
      );
      if (!attribute || found) {
        return;
      }
      if (!isVertexFormatCompatible(attribute.format, input.type)) {
        throw new Error(
          `Vertex attribute "${input.semantic}" has format ${
            attribute.format
          }, which cannot feed a ${typeToString(input.type)} input`
        );
      }
      layouts[index].attributes.push({
        format: attribute.format,
        offset: attribute.offset,
        location: input.location,
      });
      found = true;
    });
    if (!found) {
      throw new Error(`The mesh has no "${input.semantic}" attribute`);
    }
  }

  return layouts.filter((layout) => layout.attributes.length > 0);
}

// Semantics of the attributes of a mesh, for CompileOptions.vertexAttributes.
export const meshSemantics = (mesh: MeshDescription): string[] =>
  mesh.vertexBuffers.flatMap((buffer) =>
    buffer.attributes.map((attribute) => attribute.semantic)
  );
