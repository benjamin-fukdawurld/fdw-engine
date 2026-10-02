import type { GpuSampler, GpuTexture, UniformValue } from '@fdw/engine-backend';
import type { ConstantValue, MaterialGraphData } from '@fdw/engine-shader';

// A uniform value, or a texture or sampler bound by name.
export type MaterialValue = UniformValue | GpuTexture | GpuSampler;

export interface RenderState {
  // 'blend' draws the material after the opaque ones, back to front, with
  // alpha blending.
  readonly alphaMode: 'opaque' | 'blend';
  // Draws both faces of the triangles.
  readonly doubleSided: boolean;
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
}

export const defaultRenderState: RenderState = {
  alphaMode: 'opaque',
  doubleSided: false,
  depthTest: true,
  depthWrite: true,
};

// A material graph with its values. Changing a value never recompiles the
// shader: only the graph and the render state define the program and the
// pipeline.
export class Material {
  readonly graph: MaterialGraphData;
  readonly renderState: RenderState;
  readonly label?: string;

  private readonly _values = new Map<string, MaterialValue>();
  // Initial values declared by the uniforms of the graph.
  private readonly _defaults = new Map<string, ConstantValue>();
  private _version = 0;

  constructor({
    graph,
    values = {},
    renderState = {},
    label,
  }: {
    graph: MaterialGraphData;
    values?: Readonly<Record<string, MaterialValue>>;
    renderState?: Partial<RenderState>;
    label?: string;
  }) {
    this.graph = graph;
    this.renderState = { ...defaultRenderState, ...renderState };
    this.label = label;

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

  // The value set on the material, or the default declared by the graph.
  getValue(name: string): MaterialValue | undefined {
    return this._values.get(name) ?? this._defaults.get(name);
  }
}
