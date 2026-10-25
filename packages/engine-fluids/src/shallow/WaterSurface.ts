import { Material, Mesh } from '@fdw/engine-core';
import type {
  DirectionalLight,
  MaterialValue,
  WorldTransform,
} from '@fdw/engine-core';
import { Aabb } from '@fdw/engine-geometry';
import { defaultWaterLook, oceanGraph, Ops } from '@fdw/engine-ocean';
import type {
  SkyEnvironment,
  WaterItem,
  WaterLook,
  WaveShader,
} from '@fdw/engine-ocean';
import { arrayType, BuiltinTypes } from '@fdw/engine-shader';
import type { GraphBuilder, PortHandle } from '@fdw/engine-shader';
import type { ShallowGrid } from './graphs';
import type { ShallowWater } from './ShallowWater';

const vec4Array = arrayType(BuiltinTypes.vec4f);

/**
 * The shader of a {@link ShallowWater} for the material of the sea: the
 * height of its surface in the vertex stage, its slopes in the fragment
 * stage, read between the four nearest cells (bilinear) from its `surface`
 * buffer; the fast water (rapids, the edge of a splash) foams, through the
 * jacobian the material reads.
 */
export function heightFieldShader(
  water: Pick<ShallowWater, 'grid' | 'surface'>,
  options: { readonly foamSpeed?: number } = {},
): WaveShader {
  const grid = water.grid;
  const declared = new WeakMap<GraphBuilder, PortHandle>();
  const buffer = (g: GraphBuilder) => {
    let surface = declared.get(g);
    if (!surface) {
      surface = g.storage('waterSurface', vec4Array);
      declared.set(g, surface);
    }
    return surface;
  };
  const foamSpeed = options.foamSpeed ?? 2;
  return {
    displacement(g, xz) {
      const o = new Ops(g);
      return o.vec3(0, bilinear(o, grid, buffer(g), xz).swizzle('x'), 0);
    },
    derivatives(g, xz) {
      const o = new Ops(g);
      const surface = bilinear(o, grid, buffer(g), xz);
      const foam = o.smoothstep(
        foamSpeed * 0.5,
        foamSpeed * 1.5,
        surface.swizzle('w'),
      );

      const squeeze = o.mul(foam, -0.6);
      return {
        slopes: surface.swizzle('yz'),
        squeeze: o.vec3(squeeze, squeeze, 0),
        lostSlopes: o.g.constant(BuiltinTypes.f32, 0),
      };
    },
    values: () => ({ waterSurface: water.surface }),
    // The speed is -1 in the dry cells: the edge of the water halfway
    // between a wet center and a dry one.
    coverage(g, xz) {
      const o = new Ops(g);
      return o.step(-0.5, bilinear(o, grid, buffer(g), xz).swizzle('w'));
    },
  };
}

// The buffer of cells read at xz (world), between the four nearest centers,
// clamped to the grid.
function bilinear(
  o: Ops,
  grid: ShallowGrid,
  cells: PortHandle,
  xz: PortHandle,
): PortHandle {
  const uv = o.clamp(
    o.sub(o.div(o.sub(xz, [grid.origin.x, grid.origin.z]), grid.cell), 0.5),
    [0, 0],
    [grid.nx - 1, grid.nz - 1],
  );
  const cell = o.min(o.floor(uv), [grid.nx - 2, grid.nz - 2]);
  const t = o.sub(uv, cell);
  const ij = o.convert(cell, BuiltinTypes.vec2u);
  const at = (di: number, dj: number) =>
    o.index(
      cells,
      o.add(
        o.mul(o.add(ij.swizzle('y'), dj), grid.nx),
        o.add(ij.swizzle('x'), di),
      ),
    );
  return o.mix(
    o.mix(at(0, 0), at(1, 0), t.swizzle('x')),
    o.mix(at(0, 1), at(1, 1), t.swizzle('x')),
    t.swizzle('y'),
  );
}

/** The options of a {@link WaterSurface}. */
export interface WaterSurfaceOptions {
  /** What the water reflects: a cube texture (see `createSky`). */
  readonly environment: Pick<SkyEnvironment, 'texture' | 'sampler' | 'levels'>;
  /**
   * Sees what is behind the water, drawn first by an `OceanRenderer`:
   * refraction, absorption by depth, foam along the shores. Default true.
   */
  readonly refraction?: boolean;
  /** The vertices per cell of the water along each side (1). */
  readonly density?: number;
  /** The speed of the water from which it foams, in m/s (2). */
  readonly foamSpeed?: number;
  readonly look?: Partial<WaterLook>;
  readonly id?: number;
}

/** The look of clear fresh water: shallows that show their bottom, green-blue. */
export const freshWaterLook: Partial<WaterLook> = {
  scatterColor: [0.01, 0.04, 0.045],
  absorption: [0.35, 0.09, 0.08],
  subsurfaceColor: [0.04, 0.2, 0.18],
  roughness: 0.12,
  shoreFoam: 0.05,
  foamThreshold: 0.5,
  refraction: 0.06,
};

/**
 * The surface of a {@link ShallowWater}: a grid over its cells, moved to
 * the height of the water, lit by the material of the sea (`oceanGraph`):
 * the reflection of the sky, the sun, the ground seen through the water and
 * absorbed with its depth, foam where it runs fast and along its shores.
 * Drawn by an `OceanRenderer` (a {@link WaterItem}), or as any item without
 * `refraction`.
 *
 * @example
 * ```ts
 * const surface = new WaterSurface(water, { environment: sky });
 * oceanRenderer.render({ ocean: surface, source: scene, camera, surface: canvas });
 * ```
 */
export class WaterSurface implements WaterItem {
  readonly mesh: Mesh;
  readonly material: Material;
  readonly shader: WaveShader;
  readonly refraction: boolean;
  readonly castShadow = false;
  readonly id?: number;
  readonly world: WorldTransform = {
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    version: 0,
  };
  private readonly _bounds = new Aabb();

  constructor(
    readonly water: ShallowWater,
    options: WaterSurfaceOptions,
  ) {
    this.refraction = options.refraction ?? true;
    if (options.id !== undefined) {
      this.id = options.id;
    }
    this.shader = heightFieldShader(water, options);
    this.mesh = gridMesh(water.grid, options.density ?? 1);
    const look = { ...defaultWaterLook, ...freshWaterLook, ...options.look };
    const environment = options.environment;
    this.material = new Material({
      graph: oceanGraph(this.shader, {
        refraction: this.refraction,
        // The waves of a height field do not fade with the distance.
        fade: { scale: 1, limit: 1e9 },
      }),
      label: 'water',
      // The dry cells are discarded.
      renderState: { alphaMode: 'mask' },
      values: {
        ...this.shader.values(),
        ...lookValues(look),
        environment: environment.texture,
        environmentSampler: environment.sampler,
        environmentLevels: Math.max(environment.levels - 1, 0),
      },
    });
    // The ground and the water, each between its lowest and highest.
    let low = Infinity;
    let high = -Infinity;
    for (const height of water.ground) {
      low = Math.min(low, height);
      high = Math.max(high, height);
    }
    const { origin, nx, nz, cell } = water.grid;
    this._bounds.setFrom(
      [origin.x, low - 1, origin.z],
      [origin.x + nx * cell, high + water.maxDepth + 1, origin.z + nz * cell],
    );
  }

  get bounds(): Aabb {
    return this._bounds;
  }

  /** Changes how the water looks: any uniform of `WaterLook`. */
  setLook(look: Partial<WaterLook>): this {
    for (const [name, value] of Object.entries(lookValues(look))) {
      this.material.setValue(name, value);
    }
    return this;
  }

  /** The sun the water reflects: its direction and color, from a light. */
  setSun(light: DirectionalLight, intensity = 1): this {
    const { x, y, z } = light.direction;
    const { x: r, y: g, z: b } = light.diffuse;
    this.material.setValue('sunDirection', [-x, -y, -z]);
    this.material.setValue('sunColor', [
      r * intensity,
      g * intensity,
      b * intensity,
    ]);
    return this;
  }

  destroy(): void {
    this.mesh.destroy();
  }
}

// A flat grid over the cells, `density` vertices per cell along each side,
// at y = 0: the shader moves them up.
function gridMesh(grid: ShallowGrid, density: number): Mesh {
  const columns = grid.nx * density;
  const rows = grid.nz * density;
  const step = grid.cell / density;
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      positions.set(
        [grid.origin.x + i * step, 0, grid.origin.z + j * step],
        (j * (columns + 1) + i) * 3,
      );
    }
  }
  const count = (columns + 1) * (rows + 1);
  const wide = count > 65535;
  const indices = wide
    ? new Uint32Array(columns * rows * 6)
    : new Uint16Array(columns * rows * 6);
  let n = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const a = j * (columns + 1) + i;
      const b = a + columns + 1;
      // Counter-clockwise seen from above (+y).
      indices.set([a, b, a + 1, a + 1, b, b + 1], n);
      n += 6;
    }
  }
  return new Mesh({
    label: 'water grid',
    description: {
      vertexBuffers: [
        {
          stride: 12,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
          ],
        },
      ],
      vertexCount: count,
      indexBuffer: {
        format: wide ? 'uint32' : 'uint16',
        count: indices.length,
      },
    },
    vertices: [positions],
    indices,
  });
}

// The uniforms of a look.
function lookValues(look: Partial<WaterLook>): Record<string, MaterialValue> {
  const values: Record<string, MaterialValue> = {};
  for (const [name, value] of Object.entries(look)) {
    if (value !== undefined) {
      values[name] = typeof value === 'number' ? value : [...value];
    }
  }
  return values;
}
