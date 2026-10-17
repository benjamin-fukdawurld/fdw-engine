import type { PhysicalProgramLayout } from '@fdw/engine-backend';
import type { ShaderType } from '@fdw/engine-shader';

// GLSL ES 3.00 has no storage buffers. A storage buffer of WebGL2 is a data
// texture (see WebGl2Buffer): RGBA32UI, 16 bytes per texel, the bytes of the
// buffer in order, StorageTextureWidth texels per row at most. Its elements
// are read by texelFetch, their bits converted to their type; compute stages
// write them by rendering to the texture (see GlslEsCodegen.emitCompute).

/** The width of the data textures of the storage buffers, at most. */
export const StorageTextureWidth = 2048;

/**
 * The names of a storage buffer in GLSL ES: the usampler2D of its texture,
 * and a uvec3 set by the backend: the width and height of the texture, in
 * texels, and the size of the buffer, in bytes.
 */
export const StorageNames = {
  texture: (binding: string) => `s_${binding}`,
  size: (binding: string) => `s_${binding}Size`,
} as const;

/**
 * How the elements of a storage buffer lie in its texture: their stride in
 * bytes (that of the storage buffers on every backend), and for those of 16
 * bytes or more, the texels of an element (a vector, or a column of matrix
 * per texel). Scalars take a quarter of texel, vec2 a half.
 */
export function storageElement(type: ShaderType): {
  readonly stride: number;
  readonly texels: number;
} {
  switch (type.kind) {
    case 'scalar':
      return { stride: 4, texels: 0 };
    case 'vector':
      return type.size === 2
        ? { stride: 8, texels: 0 }
        : { stride: 16, texels: 1 };
    case 'matrix':
      return { stride: 16 * type.columns, texels: type.columns };
    default:
      throw new Error(`A storage buffer cannot hold ${type.kind} values`);
  }
}

const unsignedTypes: Record<number, string> = {
  1: 'uint',
  2: 'uvec2',
  3: 'uvec3',
  4: 'uvec4',
};
const signedTypes: Record<number, string> = {
  1: 'int',
  2: 'ivec2',
  3: 'ivec3',
  4: 'ivec4',
};

const sizeOf = (type: ShaderType) =>
  type.kind === 'vector' ? type.size : type.kind === 'matrix' ? type.rows : 1;
const scalarOf = (type: ShaderType) =>
  type.kind === 'scalar' || type.kind === 'vector' || type.kind === 'matrix'
    ? type.scalar
    : undefined;

// A value of a scalar or vector type, from its bits: `bits` is a uint or a
// uvecN of the same size.
function fromBits(type: ShaderType, bits: string): string {
  switch (scalarOf(type)) {
    case 'f32':
      return `uintBitsToFloat(${bits})`;
    case 'i32':
      // The conversions between int and uint keep the bits.
      return `${signedTypes[sizeOf(type)]}(${bits})`;
    default:
      return bits;
  }
}

/** The bits of a scalar or vector value: a uint or a uvecN. */
export function toBits(type: ShaderType, value: string): string {
  switch (scalarOf(type)) {
    case 'f32':
      return `floatBitsToUint(${value})`;
    case 'i32':
      return `${unsignedTypes[sizeOf(type)]}(${value})`;
    default:
      return value;
  }
}

/**
 * The bits of a scalar or vector value in a uvec4: repeated for the
 * scalars and vec2, so that every component written by a masked draw holds
 * them; a vec3 followed by its padding.
 */
export function texelOf(type: ShaderType, value: string): string {
  const bits = toBits(type, value);
  switch (sizeOf(type)) {
    case 1:
      return `uvec4(${bits})`;
    case 2:
      return `uvec4(${bits}, ${bits})`;
    case 3:
      return `uvec4(${bits}, 0u)`;
    default:
      return bits;
  }
}

const rowsOf = (rows: number) => 'xyzw'.slice(0, rows);

// The element i of a buffer, read from its texels. `type` is the GLSL type
// of the element.
function loadFunction(
  binding: string,
  element: ShaderType,
  type: string,
): string[] {
  const texture = StorageNames.texture(binding);
  const { stride, texels } = storageElement(element);
  let body: string;
  if (stride === 4) {
    body = `return ${fromBits(element, `${texture}Texel(i / 4u)[i % 4u]`)};`;
  } else if (stride === 8) {
    body = [
      `uvec4 t = ${texture}Texel(i / 2u);`,
      `  return ${fromBits(element, 'i % 2u == 0u ? t.xy : t.zw')};`,
    ].join('\n');
  } else if (element.kind === 'matrix') {
    const columns = Array.from({ length: texels }, (_, k) =>
      fromBits(
        { kind: 'vector', scalar: 'f32', size: element.rows as 2 },
        `${texture}Texel(i * ${texels}u + ${k}u).${rowsOf(element.rows)}`,
      ),
    );
    body = `return ${type}(${columns.join(', ')});`;
  } else {
    body = `return ${fromBits(
      element,
      `${texture}Texel(i).${rowsOf(sizeOf(element))}`,
    )};`;
  }
  return [`${type} ${texture}Load(uint i) {`, `  ${body}`, '}'];
}

/**
 * The declarations of the storage buffers of a layout, in both stages: for
 * each, its size, its length, and for those read (`written` excludes the
 * buffers the program renders to, which it cannot read), its texture, the
 * function reading a texel, and the one reading an element.
 */
export function storageDeclarations(
  layout: PhysicalProgramLayout,
  glslType: (type: ShaderType) => string,
  written: ReadonlySet<string> = new Set(),
): string | undefined {
  const lines: string[] = [];
  for (const group of layout.groups) {
    for (const { resource } of group.bindings) {
      if (resource.kind !== 'storage-buffer') {
        continue;
      }
      const texture = StorageNames.texture(resource.name);
      const size = StorageNames.size(resource.name);
      const element = resource.type.element;
      const { stride } = storageElement(element);
      lines.push(
        `// Storage buffer "${resource.name}": a data texture, ${stride} bytes per element.`,
        `uniform uvec3 ${size};`,
        `uint ${texture}Length() {`,
        `  return ${size}.z / ${stride}u;`,
        '}',
      );
      if (!written.has(resource.name)) {
        lines.push(
          `uniform highp usampler2D ${texture};`,
          `uvec4 ${texture}Texel(uint t) {`,
          `  return texelFetch(${texture}, ivec2(int(t % ${size}.x), int(t / ${size}.x)), 0);`,
          '}',
          ...loadFunction(resource.name, element, glslType(element)),
        );
      }
      lines.push('');
    }
  }
  lines.pop();
  return lines.length > 0 ? lines.join('\n') : undefined;
}
