// The bounds of the memory a glTF file can make the loader allocate. An
// accessor declares its `count`: without a buffer view (zeros, then sparse
// values) nothing in the file holds its bytes, so a few bytes of JSON could
// ask for gigabytes (`count: 2^29` of VEC4 floats is 8 GiB).

const MiB = 2 ** 20;
const GiB = 2 ** 30;

/**
 * The default bound of one accessor: 256 MiB. Real meshes fit: 22 million
 * VEC3 float positions or normals, 16 million VEC4 tangents, 67 million
 * uint32 indices (22 million triangles). A hostile file is stopped long
 * before it exhausts the memory of a tab or a process.
 */
export const defaultMaxAccessorBytes = 256 * MiB;

/**
 * The default bound of all the accessors of a file: 2 GiB, a mesh of about
 * 20 million vertices with positions, normals, uvs and indices, which few
 * browser tabs could hold twice.
 */
export const defaultMaxTotalAccessorBytes = 2 * GiB;

/** The environment variables of the bounds, read where there is a `process` (Node, Electron). */
export const gltfLimitVariables = {
  maxAccessorBytes: 'FDW_GLTF_MAX_ACCESSOR_BYTES',
  maxTotalAccessorBytes: 'FDW_GLTF_MAX_TOTAL_ACCESSOR_BYTES',
} as const;

/** The bounds of the accessors read from a file, in bytes; `Infinity` when unbounded. */
export interface GltfLimits {
  readonly maxAccessorBytes: number;
  readonly maxTotalAccessorBytes: number;
}

const units: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: MiB,
  mb: MiB,
  mib: MiB,
  g: GiB,
  gb: GiB,
  gib: GiB,
};

/**
 * A size in bytes: a number, or a number and a unit, `512MB`, `1.5GiB`
 * (`KB`, `MB` and `GB` are multiples of 1024, as `KiB`, `MiB` and `GiB`).
 * Undefined for anything else.
 */
export function parseByteSize(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  const unit = match && units[match[2].toLowerCase()];
  return unit ? Math.floor(Number(match[1]) * unit) : undefined;
}

function environment(name: string): string | undefined {
  const process = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  return process?.env?.[name];
}

// 0 (or Infinity) is no bound.
function bound(
  name: string,
  option: number | undefined,
  fallback: number,
): number {
  let value = option;
  if (value === undefined) {
    const variable = environment(name);
    if (variable !== undefined && variable !== '') {
      value = parseByteSize(variable);
      if (value === undefined)
        throw new Error(
          `${name}="${variable}" is not a size in bytes (as 268435456 or 256MB)`,
        );
    }
  }
  if (value === undefined) return fallback;
  if (!(value >= 0))
    throw new Error(`Invalid glTF allocation limit ${value} (${name})`);
  return value === 0 ? Infinity : value;
}

/**
 * The bounds of the options, else of the environment variables
 * (`FDW_GLTF_MAX_ACCESSOR_BYTES`, `FDW_GLTF_MAX_TOTAL_ACCESSOR_BYTES`),
 * else the defaults. 0 removes a bound.
 */
export function gltfLimits(
  options: {
    readonly maxAccessorBytes?: number;
    readonly maxTotalAccessorBytes?: number;
  } = {},
): GltfLimits {
  return {
    maxAccessorBytes: bound(
      gltfLimitVariables.maxAccessorBytes,
      options.maxAccessorBytes,
      defaultMaxAccessorBytes,
    ),
    maxTotalAccessorBytes: bound(
      gltfLimitVariables.maxTotalAccessorBytes,
      options.maxTotalAccessorBytes,
      defaultMaxTotalAccessorBytes,
    ),
  };
}

/**
 * Checks the allocations of the accessors of one file against the limits,
 * before they are made: `take(bytes, what)` throws when one is larger than
 * `maxAccessorBytes` or when the file would go past
 * `maxTotalAccessorBytes`.
 */
export class AccessorBudget {
  private used = 0;

  constructor(readonly limits: GltfLimits = gltfLimits()) {}

  take(bytes: number, what: string): void {
    const { maxAccessorBytes, maxTotalAccessorBytes } = this.limits;
    if (bytes > maxAccessorBytes)
      throw new Error(
        `${what} needs ${bytes} bytes, more than the limit of ${maxAccessorBytes} per accessor (maxAccessorBytes, ${gltfLimitVariables.maxAccessorBytes})`,
      );
    if (this.used + bytes > maxTotalAccessorBytes)
      throw new Error(
        `${what} needs ${bytes} bytes, past the limit of ${maxTotalAccessorBytes} for the accessors of a file (maxTotalAccessorBytes, ${gltfLimitVariables.maxTotalAccessorBytes})`,
      );
    this.used += bytes;
  }
}
