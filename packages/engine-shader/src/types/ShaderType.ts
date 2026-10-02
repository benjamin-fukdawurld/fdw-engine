// Logical shader types: what a shader manipulates, independently of any
// shading language or memory layout. The physical layout (size, alignment,
// offsets) is computed by each backend.

export const ScalarKindNames = ['f32', 'f16', 'i32', 'u32', 'bool'] as const;
export type ScalarKind = (typeof ScalarKindNames)[number];

export const TextureDimensionNames = [
  '1d',
  '2d',
  '2d-array',
  '3d',
  'cube',
  'cube-array',
] as const;
export type TextureDimension = (typeof TextureDimensionNames)[number];

export const TextureSampleTypeNames = [
  'float',
  'unfilterable-float',
  'depth',
  'sint',
  'uint',
] as const;
export type TextureSampleType = (typeof TextureSampleTypeNames)[number];

export type VectorSize = 2 | 3 | 4;
export type MatrixSize = 2 | 3 | 4;

export type ScalarType = {
  readonly kind: 'scalar';
  readonly scalar: ScalarKind;
};

export type VectorType = {
  readonly kind: 'vector';
  readonly size: VectorSize;
  readonly scalar: ScalarKind;
};

export type MatrixType = {
  readonly kind: 'matrix';
  readonly columns: MatrixSize;
  readonly rows: MatrixSize;
  readonly scalar: 'f32' | 'f16';
};

export type ArrayType = {
  readonly kind: 'array';
  readonly element: ShaderType;
  // Absent for runtime-sized arrays (storage buffers only).
  readonly length?: number;
};

export type StructType = {
  readonly kind: 'struct';
  readonly name: string;
  readonly fields: readonly {
    readonly name: string;
    readonly type: ShaderType;
  }[];
};

export type TextureType = {
  readonly kind: 'texture';
  readonly dimension: TextureDimension;
  readonly sampleType: TextureSampleType;
  readonly multisampled?: boolean;
};

export type SamplerType = {
  readonly kind: 'sampler';
  readonly comparison: boolean;
};

export type ShaderType =
  | ScalarType
  | VectorType
  | MatrixType
  | ArrayType
  | StructType
  | TextureType
  | SamplerType;

export const scalar = (kind: ScalarKind): ScalarType => ({
  kind: 'scalar',
  scalar: kind,
});

export const vec = (
  size: VectorSize,
  kind: ScalarKind = 'f32'
): VectorType => ({
  kind: 'vector',
  size,
  scalar: kind,
});

export const mat = (
  columns: MatrixSize,
  rows: MatrixSize,
  kind: 'f32' | 'f16' = 'f32'
): MatrixType => ({ kind: 'matrix', columns, rows, scalar: kind });

export const arrayType = (element: ShaderType, length?: number): ArrayType =>
  length === undefined
    ? { kind: 'array', element }
    : { kind: 'array', element, length };

export const structType = (
  name: string,
  fields: readonly { name: string; type: ShaderType }[]
): StructType => ({ kind: 'struct', name, fields });

export const texture = (
  dimension: TextureDimension,
  sampleType: TextureSampleType = 'float',
  multisampled?: boolean
): TextureType =>
  multisampled
    ? { kind: 'texture', dimension, sampleType, multisampled }
    : { kind: 'texture', dimension, sampleType };

export const sampler = (comparison = false): SamplerType => ({
  kind: 'sampler',
  comparison,
});

// Shortcuts for the most common types.
export const T = {
  f32: scalar('f32'),
  f16: scalar('f16'),
  i32: scalar('i32'),
  u32: scalar('u32'),
  bool: scalar('bool'),
  vec2f: vec(2, 'f32'),
  vec3f: vec(3, 'f32'),
  vec4f: vec(4, 'f32'),
  vec2i: vec(2, 'i32'),
  vec3i: vec(3, 'i32'),
  vec4i: vec(4, 'i32'),
  vec2u: vec(2, 'u32'),
  vec3u: vec(3, 'u32'),
  vec4u: vec(4, 'u32'),
  mat3f: mat(3, 3),
  mat4f: mat(4, 4),
  texture2d: texture('2d', 'float'),
  textureCube: texture('cube', 'float'),
  depthTexture2d: texture('2d', 'depth'),
  sampler: sampler(false),
  comparisonSampler: sampler(true),
} as const;

export function isNumericScalarKind(kind: ScalarKind): boolean {
  return kind !== 'bool';
}

export function isFloatScalarKind(kind: ScalarKind): boolean {
  return kind === 'f32' || kind === 'f16';
}

export function typeEquals(a: ShaderType, b: ShaderType): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case 'scalar':
      return a.scalar === (b as ScalarType).scalar;
    case 'vector': {
      const other = b as VectorType;
      return a.size === other.size && a.scalar === other.scalar;
    }
    case 'matrix': {
      const other = b as MatrixType;
      return (
        a.columns === other.columns &&
        a.rows === other.rows &&
        a.scalar === other.scalar
      );
    }
    case 'array': {
      const other = b as ArrayType;
      return a.length === other.length && typeEquals(a.element, other.element);
    }
    case 'struct': {
      const other = b as StructType;
      return (
        a.name === other.name &&
        a.fields.length === other.fields.length &&
        a.fields.every(
          (field, i) =>
            field.name === other.fields[i].name &&
            typeEquals(field.type, other.fields[i].type)
        )
      );
    }
    case 'texture': {
      const other = b as TextureType;
      return (
        a.dimension === other.dimension &&
        a.sampleType === other.sampleType &&
        !!a.multisampled === !!other.multisampled
      );
    }
    case 'sampler':
      return a.comparison === (b as SamplerType).comparison;
  }
}

// Readable, language-neutral representation used in diagnostics.
export function typeToString(type: ShaderType): string {
  switch (type.kind) {
    case 'scalar':
      return type.scalar;
    case 'vector':
      return `vec${type.size}<${type.scalar}>`;
    case 'matrix':
      return `mat${type.columns}x${type.rows}<${type.scalar}>`;
    case 'array':
      return type.length === undefined
        ? `array<${typeToString(type.element)}>`
        : `array<${typeToString(type.element)}, ${type.length}>`;
    case 'struct':
      return type.name;
    case 'texture':
      return `texture_${type.dimension}${type.multisampled ? '_ms' : ''}<${
        type.sampleType
      }>`;
    case 'sampler':
      return type.comparison ? 'sampler_comparison' : 'sampler';
  }
}
