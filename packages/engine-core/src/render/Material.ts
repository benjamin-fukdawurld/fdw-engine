import type { GpuSampler, GpuTexture, UniformValue } from '@fdw/engine-backend';
import type {
  ConstantValue,
  MaterialGraphData,
  StaticValue,
} from '@fdw/engine-shader';

// A uniform value, or a texture or sampler bound by name.
export type MaterialValue = UniformValue | GpuTexture | GpuSampler;

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
  }: {
    graph: MaterialGraphData;
    values?: Readonly<Record<string, MaterialValue>>;
    // Static parameters read by the macros of the graph: changing one
    // selects another variant of the program.
    features?: Readonly<Record<string, StaticValue>>;
    renderState?: Partial<RenderState>;
    label?: string;
  }) {
    this.graph = graph;
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
          value as ConstantValue
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
}
