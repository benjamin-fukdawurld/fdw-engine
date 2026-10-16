import {
  BlendFactor,
  BlendState,
  CompareFunction,
  GpuBindGroup,
  GpuBindGroupEntry,
  GpuBindGroupLayout,
  GpuComputePipeline,
  GpuPipelineFactory,
  GpuRenderPipeline,
  matchVertexLayout,
  PhysicalBindGroup,
  PhysicalProgramLayout,
  PrimitiveTopology,
  RenderPipelineDescriptor,
  VertexBufferLayout,
  std140LayoutStrategy,
} from '@fdw/engine-backend';
import type { CompiledProgram } from '@fdw/engine-shader';
import { GL, lazy } from '../gl';
import {
  combinedSamplers,
  orientationUniform,
} from '../shader/combinedSamplers';
import {
  GlslEsCodegen,
  glslBlockName,
  ObjectTableNames,
} from '../shader/GlslEsCodegen';

// Where a resource of a bind group is found: group index and binding.
interface BindingRef {
  readonly group: number;
  readonly binding: number;
}

// A linked program, with the binding points of its uniform blocks and the
// texture units of its combined samplers.
export interface WebGl2Program {
  readonly program: WebGLProgram;
  readonly uniformBlocks: readonly (BindingRef & { readonly point: number })[];
  readonly samplers: readonly {
    readonly unit: number;
    readonly texture: BindingRef;
    // None for the textures read by textureLoad (texelFetch).
    readonly sampler?: BindingRef;
    // The orientation of a 2d texture (see orientationUniform), set when
    // it is bound.
    readonly orientation?: WebGLUniformLocation;
  }[];
  // The object table: its two data textures on the units after those of
  // the samplers, and the uniform of the first instance of a draw.
  readonly objectTable?: {
    readonly binding: BindingRef;
    readonly rowsUnit: number;
    readonly instancesUnit: number;
    readonly firstInstance: WebGLUniformLocation | null;
  };
}

export interface WebGl2BlendState {
  readonly color: readonly [GLenum, GLenum, GLenum];
  readonly alpha: readonly [GLenum, GLenum, GLenum];
}

export class WebGl2RenderPipeline implements GpuRenderPipeline {
  constructor(
    readonly program: WebGl2Program,
    // The vertex buffers read by the program, in slot order.
    readonly buffers: readonly VertexBufferLayout[],
    readonly vertexArray: WebGLVertexArrayObject,
    readonly topology: GLenum,
    // Undefined when no face is culled.
    readonly cullFace: GLenum | undefined,
    readonly frontFace: GLenum,
    readonly depth:
      | {
          readonly write: boolean;
          readonly compare: GLenum;
          // polygonOffset(slope, constant), when not zero.
          readonly bias?: { readonly slope: number; readonly constant: number };
        }
      | undefined,
    readonly blend: WebGl2BlendState | undefined,
    readonly label?: string
  ) {}

  get vertexBuffers(): readonly number[] {
    return this.buffers.map((buffer) => buffer.buffer);
  }
}

export class WebGl2BindGroupLayout implements GpuBindGroupLayout {
  constructor(readonly key: string) {}
}

export class WebGl2BindGroup implements GpuBindGroup {
  constructor(
    readonly layout: WebGl2BindGroupLayout,
    // Resources by binding number.
    readonly resources: ReadonlyMap<number, GpuBindGroupEntry['resource']>
  ) {}
}

const topologies = lazy(
  (): Record<PrimitiveTopology, GLenum> => ({
    'triangle-list': GL.TRIANGLES,
    'triangle-strip': GL.TRIANGLE_STRIP,
    'line-list': GL.LINES,
    'line-strip': GL.LINE_STRIP,
    'point-list': GL.POINTS,
  })
);

const compareFunctions = lazy(
  (): Record<CompareFunction, GLenum> => ({
    never: GL.NEVER,
    less: GL.LESS,
    equal: GL.EQUAL,
    'less-equal': GL.LEQUAL,
    greater: GL.GREATER,
    'not-equal': GL.NOTEQUAL,
    'greater-equal': GL.GEQUAL,
    always: GL.ALWAYS,
  })
);

const blendFactors = lazy(
  (): Record<BlendFactor, GLenum> => ({
    zero: GL.ZERO,
    one: GL.ONE,
    'src-alpha': GL.SRC_ALPHA,
    'one-minus-src-alpha': GL.ONE_MINUS_SRC_ALPHA,
    'dst-alpha': GL.DST_ALPHA,
    'one-minus-dst-alpha': GL.ONE_MINUS_DST_ALPHA,
  })
);

const blendOperations = lazy(() => ({
  add: GL.FUNC_ADD,
  subtract: GL.FUNC_SUBTRACT,
  'reverse-subtract': GL.FUNC_REVERSE_SUBTRACT,
  min: GL.MIN,
  max: GL.MAX,
}));

function blendState(blend: BlendState): WebGl2BlendState {
  const component = (c: BlendState['color']) =>
    [
      blendFactors()[c.srcFactor],
      blendFactors()[c.dstFactor],
      blendOperations()[c.operation],
    ] as const;
  return { color: component(blend.color), alpha: component(blend.alpha) };
}

function shaderLog(
  gl: WebGL2RenderingContext,
  shader: WebGLShader,
  stage: string,
  source: string
): string | undefined {
  if (gl.getShaderParameter(shader, GL.COMPILE_STATUS)) {
    return undefined;
  }
  const numbered = source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
    .join('\n');
  return `${stage} shader:\n${gl.getShaderInfoLog(shader)}\n${numbered}`;
}

// Polls the completion of a link with KHR_parallel_shader_compile, without
// blocking the main thread.
function linked(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  completionStatus: GLenum
): Promise<void> {
  return new Promise((resolve) => {
    const poll = () => {
      if (gl.getProgramParameter(program, completionStatus)) {
        resolve();
      } else {
        setTimeout(poll, 4);
      }
    };
    poll();
  });
}

export class WebGl2PipelineFactory implements GpuPipelineFactory {
  readonly codegen = new GlslEsCodegen();
  readonly layoutStrategy = std140LayoutStrategy;

  private readonly _layouts = new Map<string, PhysicalProgramLayout>();
  private readonly _programs = new Map<string, Promise<WebGl2Program>>();
  private readonly _linkedPrograms = new Map<string, WebGl2Program>();
  private readonly _bindGroupLayouts = new Map<string, WebGl2BindGroupLayout>();
  private readonly _parallelCompile: { COMPLETION_STATUS_KHR: GLenum } | null;

  constructor(readonly gl: WebGL2RenderingContext) {
    this._parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
  }

  resolveLayout(program: CompiledProgram): PhysicalProgramLayout {
    let layout = this._layouts.get(program.programKey);
    if (!layout) {
      layout = this.layoutStrategy.resolve(program.layout);
      this._layouts.set(program.programKey, layout);
    }
    return layout;
  }

  // Layouts only matter for compatibility between bind groups and pipelines:
  // their key is the kinds of their resources.
  createBindGroupLayout(group: PhysicalBindGroup): WebGl2BindGroupLayout {
    const key = JSON.stringify(
      group.bindings.map(({ binding, resource, block }) => [
        binding,
        resource.kind,
        resource.kind === 'texture' ? resource.type : block?.size,
      ])
    );
    let layout = this._bindGroupLayouts.get(key);
    if (!layout) {
      layout = new WebGl2BindGroupLayout(key);
      this._bindGroupLayouts.set(key, layout);
    }
    return layout;
  }

  createBindGroup(
    layout: GpuBindGroupLayout,
    entries: readonly GpuBindGroupEntry[]
  ): GpuBindGroup {
    if (!(layout instanceof WebGl2BindGroupLayout)) {
      throw new Error(
        'The bind group layout was not created by the WebGL2 backend'
      );
    }
    return new WebGl2BindGroup(
      layout,
      new Map(entries.map((entry) => [entry.binding, entry.resource]))
    );
  }

  createRenderPipeline(
    descriptor: RenderPipelineDescriptor
  ): GpuRenderPipeline {
    const { program } = descriptor;
    let linkedProgram = this._linkedPrograms.get(program.programKey);
    if (!linkedProgram) {
      const { program: glProgram, finish } = this.link(program);
      linkedProgram = finish(glProgram);
    }
    return this.pipeline(descriptor, linkedProgram);
  }

  createComputePipeline(): GpuComputePipeline {
    throw new Error('WebGL2 has no compute shaders');
  }

  async createComputePipelineAsync(): Promise<GpuComputePipeline> {
    throw new Error('WebGL2 has no compute shaders');
  }

  async createRenderPipelineAsync(
    descriptor: RenderPipelineDescriptor
  ): Promise<GpuRenderPipeline> {
    const { program } = descriptor;
    let pending = this._programs.get(program.programKey);
    if (!pending) {
      const { program: glProgram, finish } = this.link(program);
      pending = (
        this._parallelCompile
          ? linked(
              this.gl,
              glProgram,
              this._parallelCompile.COMPLETION_STATUS_KHR
            )
          : Promise.resolve()
      ).then(() => finish(glProgram));
      this._programs.set(program.programKey, pending);
      // A failed link can be retried.
      pending.catch(() => this._programs.delete(program.programKey));
    }
    return this.pipeline(descriptor, await pending);
  }

  // Starts compiling and linking a program. finish() checks the result and
  // assigns the binding points; with KHR_parallel_shader_compile, it should
  // only be called once the link is complete, not to block.
  private link(compiled: CompiledProgram): {
    program: WebGLProgram;
    finish: (program: WebGLProgram) => WebGl2Program;
  } {
    const gl = this.gl;
    const layout = this.resolveLayout(compiled);
    const sources = this.codegen.emit(compiled.module, layout);
    if (sources.kind !== 'per-stage') {
      throw new Error('The GLSL generator must produce one source per stage');
    }
    const shader = (type: GLenum, source: string) => {
      const result = gl.createShader(type) as WebGLShader;
      gl.shaderSource(result, source);
      gl.compileShader(result);
      return result;
    };
    const vertex = shader(GL.VERTEX_SHADER, sources.vertex);
    const fragment = shader(GL.FRAGMENT_SHADER, sources.fragment);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    const finish = (linkedProgram: WebGLProgram): WebGl2Program => {
      const cached = this._linkedPrograms.get(compiled.programKey);
      if (cached) {
        return cached;
      }
      if (!gl.getProgramParameter(linkedProgram, GL.LINK_STATUS)) {
        const logs = [
          shaderLog(gl, vertex, 'Vertex', sources.vertex),
          shaderLog(gl, fragment, 'Fragment', sources.fragment),
          gl.getProgramInfoLog(linkedProgram),
        ].filter(Boolean);
        gl.deleteProgram(linkedProgram);
        throw new Error(
          `Program "${compiled.name}" failed to link:\n${logs.join('\n')}`
        );
      }
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      const result = this.assignBindings(linkedProgram, compiled, layout);
      this._linkedPrograms.set(compiled.programKey, result);
      return result;
    };
    return { program, finish };
  }

  // GLSL ES 3.00 has no binding qualifiers: the binding points of the uniform
  // blocks and the texture units of the samplers are set after linking.
  // Blocks and samplers optimized out by the driver are skipped.
  private assignBindings(
    program: WebGLProgram,
    compiled: CompiledProgram,
    layout: PhysicalProgramLayout
  ): WebGl2Program {
    const gl = this.gl;
    const bindingOf = new Map<string, BindingRef>();
    const uniformBlocks: (BindingRef & { point: number })[] = [];
    for (const group of layout.groups) {
      for (const { binding, resource } of group.bindings) {
        bindingOf.set(resource.name, { group: group.index, binding });
        if (resource.kind !== 'uniform-block') {
          continue;
        }
        const index = gl.getUniformBlockIndex(
          program,
          glslBlockName(resource.name)
        );
        if (index === GL.INVALID_INDEX) {
          continue;
        }
        const point = uniformBlocks.length;
        gl.uniformBlockBinding(program, index, point);
        uniformBlocks.push({ group: group.index, binding, point });
      }
    }

    gl.useProgram(program);
    const samplers = combinedSamplers(compiled.module, layout).flatMap(
      (sampler, unit) => {
        const location = gl.getUniformLocation(program, sampler.name);
        if (!location) {
          return [];
        }
        gl.uniform1i(location, unit);
        const name = orientationUniform(sampler);
        const orientation = name && gl.getUniformLocation(program, name);
        return [
          {
            unit,
            texture: bindingOf.get(sampler.texture) as BindingRef,
            ...(sampler.sampler !== undefined
              ? { sampler: bindingOf.get(sampler.sampler) as BindingRef }
              : {}),
            ...(orientation ? { orientation } : {}),
          },
        ];
      }
    );
    const objectTable = this.objectTable(program, layout, samplers.length);
    gl.useProgram(null);

    return {
      program,
      uniformBlocks,
      samplers,
      ...(objectTable ? { objectTable } : {}),
    };
  }

  // The units of the textures of the object table, after those of the
  // samplers (the program is in use).
  private objectTable(
    program: WebGLProgram,
    layout: PhysicalProgramLayout,
    units: number
  ): WebGl2Program['objectTable'] {
    const gl = this.gl;
    for (const group of layout.groups) {
      for (const { binding, resource } of group.bindings) {
        if (resource.kind !== 'object-table') {
          continue;
        }
        const rowsUnit = units;
        const instancesUnit = units + 1;
        const rows = gl.getUniformLocation(program, ObjectTableNames.rows);
        const instances = gl.getUniformLocation(
          program,
          ObjectTableNames.instances
        );
        if (rows) {
          gl.uniform1i(rows, rowsUnit);
        }
        if (instances) {
          gl.uniform1i(instances, instancesUnit);
        }
        return {
          binding: { group: group.index, binding },
          rowsUnit,
          instancesUnit,
          firstInstance: gl.getUniformLocation(
            program,
            ObjectTableNames.firstInstance
          ),
        };
      }
    }
    return undefined;
  }

  private pipeline(
    descriptor: RenderPipelineDescriptor,
    program: WebGl2Program
  ): WebGl2RenderPipeline {
    const { primitive, depthStencil, targets } = descriptor;
    const buffers = matchVertexLayout(
      descriptor.program.vertexInputs,
      descriptor.vertex
    );
    // One blend state for every color target (no independent blending
    // without OES_draw_buffers_indexed); integer targets are never blended.
    const blended = targets.filter((target) => !/int$/.test(target.format));
    const blend = blended[0]?.blend;
    if (
      blended.some(
        (target) => JSON.stringify(target.blend) !== JSON.stringify(blend)
      )
    ) {
      throw new Error(
        `Pipeline "${
          descriptor.label ?? descriptor.program.name
        }": WebGL2 blends every color target the same way (capability independentBlend)`
      );
    }
    return new WebGl2RenderPipeline(
      program,
      buffers,
      this.gl.createVertexArray(),
      topologies()[primitive.topology],
      primitive.cullMode === 'none'
        ? undefined
        : primitive.cullMode === 'front'
        ? GL.FRONT
        : GL.BACK,
      primitive.frontFace === 'ccw' ? GL.CCW : GL.CW,
      depthStencil
        ? {
            write: depthStencil.depthWrite,
            compare: compareFunctions()[depthStencil.depthCompare],
            ...(depthStencil.depthBias || depthStencil.depthBiasSlopeScale
              ? {
                  bias: {
                    slope: depthStencil.depthBiasSlopeScale ?? 0,
                    constant: depthStencil.depthBias ?? 0,
                  },
                }
              : {}),
          }
        : undefined,
      blend ? blendState(blend) : undefined,
      descriptor.label ?? descriptor.program.name
    );
  }
}
