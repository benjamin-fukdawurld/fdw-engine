import type {
  GpuBuffer,
  GpuSampler,
  GpuTexture,
  GpuTopLevel,
  UniformValue,
} from '@fdw/engine-backend';
import type { DeformedVertices } from './rays';
import type {
  ConstantValue,
  MaterialGraphData,
  StaticValue,
} from '@fdw/engine-shader';

// A uniform value, or a texture, sampler, storage buffer or acceleration
// structure (of the programs tracing rays) bound by name.
export type MaterialValue =
  UniformValue | GpuTexture | GpuSampler | GpuBuffer | GpuTopLevel;

export interface RenderState {
  // 'blend' draws the material after the opaque ones, back to front, with
  // alpha blending. 'mask' discards the fragments whose alpha is below the
  // 'alphaCutoff' value (0.5 by default), and is drawn with the opaque ones.
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  // Draws both faces of the triangles.
  readonly doubleSided: boolean;
  readonly depthTest: boolean;
  // Defaults to false for transparent materials: they must not hide what is
  // behind them, including their own back faces.
  readonly depthWrite: boolean;
}

export const defaultRenderState: RenderState = {
  alphaMode: 'opaque',
  doubleSided: false,
  depthTest: true,
  depthWrite: true,
};

// A material graph with its values. Changing a value never recompiles the
// shader: only the graph, the features and the render state define the
// program and the pipeline.
export class Material {
  readonly graph: MaterialGraphData;
  readonly renderState: RenderState;
  readonly label?: string;
  /**
   * The vertices of the mesh as its graph moves them, written on the GPU
   * each frame (a skinning): what the rays see of the items drawn with it.
   */
  readonly deformedVertices?: DeformedVertices;

  private readonly _values = new Map<string, MaterialValue>();
  private _features: Readonly<Record<string, StaticValue>>;
  // Initial values declared by the uniforms of the graph.
  private readonly _defaults = new Map<string, ConstantValue>();
  private _version = 0;

  constructor({
    graph,
    values = {},
    features = {},
    renderState = {},
    label,
    deformedVertices,
  }: {
    graph: MaterialGraphData;
    values?: Readonly<Record<string, MaterialValue>>;
    // Static parameters read by the macros of the graph: changing one
    // selects another variant of the program.
    features?: Readonly<Record<string, StaticValue>>;
    renderState?: Partial<RenderState>;
    label?: string;
    deformedVertices?: DeformedVertices;
  }) {
    this.graph = graph;
    if (deformedVertices) {
      this.deformedVertices = deformedVertices;
    }
    this._features = { ...features };
    this.renderState = {
      ...defaultRenderState,
      depthWrite: renderState.alphaMode !== 'blend',
      ...renderState,
    };
    this.label = label;

    // The uniform inserted by the compiler for masked materials.
    if (this.renderState.alphaMode === 'mask') {
      this._defaults.set('alphaCutoff', 0.5);
    }
    for (const node of graph.nodes) {
      const value = node.params['default'];
      if (node.type === 'input.uniform' && value !== undefined) {
        this._defaults.set(
          node.params['name'] as string,
          value as ConstantValue,
        );
      }
    }
    for (const [name, value] of Object.entries(values)) {
      this._values.set(name, value);
    }
  }

  // Incremented on every value change.
  get version(): number {
    return this._version;
  }

  /** The values set on the material (not the defaults of the graph). */
  get values(): ReadonlyMap<string, MaterialValue> {
    return this._values;
  }

  setValue(name: string, value: MaterialValue): this {
    this._values.set(name, value);
    this._version++;
    return this;
  }

  get features(): Readonly<Record<string, StaticValue>> {
    return this._features;
  }

  // Selects another variant of the program: compiled on the next frame if it
  // is not in the cache yet.
  setFeature(name: string, value: StaticValue): this {
    this._features = { ...this._features, [name]: value };
    return this;
  }

  // The value set on the material, or the default declared by the graph.
  getValue(name: string): MaterialValue | undefined {
    return this._values.get(name) ?? this._defaults.get(name);
  }

  // A new material drawing another graph with the values, features and
  // render state of this one, and `values` on top: a variant made by a tool
  // (the skinning of a mesh adds its nodes to the graph). Later changes of
  // either do not reach the other.
  withGraph(
    graph: MaterialGraphData,
    values: Readonly<Record<string, MaterialValue>> = {},
    { deformedVertices }: { deformedVertices?: DeformedVertices } = {},
  ): Material {
    return new Material({
      graph,
      values: { ...Object.fromEntries(this._values), ...values },
      features: this._features,
      renderState: this.renderState,
      ...(this.label !== undefined ? { label: this.label } : {}),
      ...(deformedVertices ? { deformedVertices } : {}),
    });
  }
}
