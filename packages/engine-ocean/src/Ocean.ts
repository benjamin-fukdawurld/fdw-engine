import type { IVec3, Mat4 } from '@fdw/engine-backend';
import { Material, Mesh } from '@fdw/engine-core';
import type {
  DirectionalLight,
  MaterialValue,
  WorldRenderItem,
  WorldTransform,
} from '@fdw/engine-core';
import { Aabb } from '@fdw/engine-geometry';
import { clipmapGrid, ClipmapGrid, ClipmapOptions } from './clipmap';
import { GerstnerWaves } from './gerstner';
import { defaultWaterLook, oceanGraph, WaterLook } from './material';
import type { OceanSpectrum } from './OceanSpectrum';
import { sampleJacobian, sampleNormal, waveSample, WaveSample } from './sample';
import { gerstnerShader, spectrumShader, WaveShader } from './shader';
import type { SkyEnvironment } from './sky';

/** The waves of an {@link Ocean}. */
export type Waves = GerstnerWaves | OceanSpectrum;

/** The options of an {@link Ocean}. */
export interface OceanOptions {
  readonly waves: Waves;
  /** What the water reflects: a cube texture (see {@link createSky}). */
  readonly environment: Pick<SkyEnvironment, 'texture' | 'sampler' | 'levels'>;
  /** The height of the still sea, in meters (0). */
  readonly level?: number;
  /**
   * Sees what is behind the water (the {@link OceanRenderer} draws it
   * first): refraction, absorption by depth, foam along the shores. Without
   * it, the water is opaque and can be drawn as any item. Default true.
   */
  readonly refraction?: boolean;
  /** The rings of the grid around the camera. */
  readonly grid?: ClipmapOptions;
  /**
   * Where the waves fade out of the vertices, as a multiple of their
   * length (or the side of their tile): beyond it, the vertices are too far
   * apart to follow them; the pixels still do. Default 2.
   */
  readonly fade?: number;
  readonly look?: Partial<WaterLook>;
  readonly id?: number;
}

/**
 * A sea, drawn on a grid of rings that follows the camera, its vertices
 * moved by the waves (sums of Gerstner waves, or the spectrum of an
 * {@link OceanSpectrum}), its pixels lit by the environment and the sun.
 * A render item: {@link Ocean.update} once a frame with the camera, then
 * draw it, through an {@link OceanRenderer} to see what is under the
 * water. {@link Ocean.heightAt} gives the height of the water to the
 * physics ({@link Buoyancy}).
 *
 * @example
 * ```ts
 * const sky = createSky(backend);
 * const ocean = new Ocean({ waves: new OceanSpectrum(backend), environment: sky });
 * // Each frame:
 * ocean.update(camera.position, time);
 * oceanRenderer.render({ ocean, items, camera, surface });
 * ```
 */
export class Ocean implements WorldRenderItem {
  readonly waves: Waves;
  readonly mesh: Mesh;
  readonly material: Material;
  readonly grid: ClipmapGrid;
  readonly shader: WaveShader;
  readonly refraction: boolean;
  readonly castShadow = false;
  readonly id?: number;
  readonly level: number;

  private readonly _world: { matrix: Mat4; version: number };
  private readonly _bounds = new Aabb();

  constructor(options: OceanOptions) {
    this.waves = options.waves;
    this.level = options.level ?? 0;
    this.refraction = options.refraction ?? true;
    if (options.id !== undefined) {
      this.id = options.id;
    }
    this.grid = clipmapGrid(options.grid);
    this.mesh = this.grid.mesh;
    this.shader =
      this.waves instanceof GerstnerWaves
        ? gerstnerShader(this.waves)
        : spectrumShader(this.waves);
    const graph = oceanGraph(this.shader, {
      refraction: this.refraction,
      fade: {
        scale: options.fade ?? 2,
        // Faded before the skirt, whose edges are not stitched.
        limit: this.grid.extent - 2 * this.grid.step,
      },
    });
    const look = { ...defaultWaterLook, ...options.look };
    const environment = options.environment;
    this.material = new Material({
      graph,
      label: 'ocean',
      values: {
        ...this.shader.values(),
        ...lookValues(look),
        environment: environment.texture,
        environmentSampler: environment.sampler,
        environmentLevels: Math.max(environment.levels - 1, 0),
      },
    });
    this._world = {
      matrix: new Float32Array([
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        this.level,
        0,
        1,
      ]),
      version: 0,
    };
    this.updateBounds();
  }

  get world(): WorldTransform {
    return this._world;
  }

  /** The bounds of the grid, the waves included. */
  get bounds(): Aabb {
    return this._bounds;
  }

  /** Changes how the water looks: any uniform of {@link WaterLook}. */
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

  /**
   * Once a frame, before drawing: the waves at `time` (the spectrum is
   * computed on the GPU), and the grid under the camera, moved by steps of
   * its coarsest cell.
   */
  update(camera: IVec3, time: number): this {
    this.waves.update(time);
    for (const [name, value] of Object.entries(this.shader.values())) {
      if (this.material.getValue(name) !== value) {
        this.material.setValue(name, value);
      }
    }
    const step = this.grid.step;
    const x = Math.round(camera.x / step) * step;
    const z = Math.round(camera.z / step) * step;
    const matrix = this._world.matrix;
    if (matrix[12] !== x || matrix[14] !== z) {
      matrix[12] = x;
      matrix[14] = z;
      this._world.version++;
      this.updateBounds();
    }
    return this;
  }

  /** The height of the water above a point of the world (x, z), in meters. */
  heightAt(x: number, z: number): number {
    return this.level + this.waves.heightAt(x, z);
  }

  /**
   * The water that the waves move above (x, z): the point of the still
   * surface, its displacement and derivatives, the normal and the
   * jacobian (the foam below 1).
   */
  sampleAt(
    x: number,
    z: number,
  ): {
    sample: WaveSample;
    normal: { x: number; y: number; z: number };
    jacobian: number;
  } {
    const sample = waveSample();
    let x0 = x;
    let z0 = z;
    for (let i = 0; i < 6; i++) {
      this.waves.sample(x0, z0, sample);
      x0 = x - sample.dx;
      z0 = z - sample.dz;
    }
    this.waves.sample(x0, z0, sample);
    return {
      sample,
      normal: sampleNormal(sample),
      jacobian: sampleJacobian(sample),
    };
  }

  destroy(): void {
    this.mesh.destroy();
  }

  private updateBounds(): void {
    const reach = this.grid.horizon;
    const x = this._world.matrix[12];
    const z = this._world.matrix[14];
    const height = this.waves.maxHeight;
    const horizontal = this.waves.maxHorizontal;
    this._bounds.setFrom(
      [x - reach - horizontal, this.level - height, z - reach - horizontal],
      [x + reach + horizontal, this.level + height, z + reach + horizontal],
    );
  }
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
