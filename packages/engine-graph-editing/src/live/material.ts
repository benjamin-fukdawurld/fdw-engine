import type { GpuTexture, RenderBackend } from '@fdw/engine-backend';
import {
  Camera,
  DirectionalLight,
  type Material,
  type Mesh,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import { type Diagnostic, GraphError, type NodeId } from '@fdw/engine-graph';
import {
  type CompiledProgram,
  compile,
  type MaterialGraphData,
  type NodeRegistry,
} from '@fdw/engine-shader';
import type { MaterialCode } from '../protocol';

/** What a material graph compiles with, as a renderer would. */
export interface MaterialCompileOptions {
  readonly registry?: NodeRegistry;
  /** The attributes of the meshes: position, normal and uv by default. */
  readonly vertexAttributes?: readonly string[];
  /** The limits of the backend, its features (`objectTable`). */
  readonly capabilities?: RenderBackend['capabilities'];
}

/** The result of {@link compileMaterial}. */
export type MaterialCompilation =
  | {
      readonly program: CompiledProgram;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly program?: undefined;
      readonly diagnostics: readonly Diagnostic[];
    };

const defaultAttributes = ['position', 'normal', 'uv'];

/**
 * Compiles a material graph as the renderer does (the object table, the
 * attributes of the meshes), without throwing: the program, or the
 * problems found.
 */
export function compileMaterial(
  graph: MaterialGraphData,
  options: MaterialCompileOptions = {},
): MaterialCompilation {
  try {
    const program = compile(graph, {
      vertexAttributes: options.vertexAttributes ?? defaultAttributes,
      capabilities: { ...options.capabilities, objectTable: true },
      ...(options.registry && { registry: options.registry }),
    });
    return { program, diagnostics: program.diagnostics };
  } catch (error) {
    if (error instanceof GraphError) {
      return { diagnostics: error.diagnostics };
    }
    return {
      diagnostics: [{ severity: 'error', message: (error as Error).message }],
    };
  }
}

/**
 * Where the nodes are in generated code: the lines the generators mark
 * with `// #id`, by line number (from 1). The ids not among `nodes` (those
 * of a node made by the compiler) are left out.
 */
export function sourceMap(
  code: string,
  nodes?: ReadonlySet<NodeId>,
): Record<number, NodeId> {
  const lines: Record<number, NodeId> = {};
  code.split('\n').forEach((line, index) => {
    const match = /\/\/ #([^\s]+)\s*$/.exec(line);
    if (!match) return;
    const id = match[1];
    if (!nodes || nodes.has(id)) lines[index + 1] = id;
  });
  return lines;
}

/**
 * The code a program is drawn with on a backend (its generator and its
 * layout), and its source map.
 */
export function materialCode(
  backend: RenderBackend,
  program: CompiledProgram,
  nodes?: ReadonlySet<NodeId>,
  time = 0,
): MaterialCode {
  const pipelines = backend.pipelines;
  const emitted = pipelines.codegen.emit(
    program.module,
    pipelines.resolveLayout(program),
  );
  const sources =
    emitted.kind === 'single-module'
      ? [{ stage: 'module', code: emitted.code }]
      : [
          { stage: 'vertex', code: emitted.vertex },
          { stage: 'fragment', code: emitted.fragment },
        ];
  return {
    language: pipelines.codegen.language,
    sources,
    lines: sources.map((source) => sourceMap(source.code, nodes)),
    diagnostics: program.diagnostics,
    time,
  };
}

/** The meshes of a preview, made by the application. */
export interface PreviewMeshes {
  readonly sphere: Mesh;
  readonly cube: Mesh;
  readonly plane: Mesh;
}

/** The shapes of a preview. */
export type PreviewShape = keyof PreviewMeshes;

/**
 * A material drawn alone, lit, into a texture read back: the preview of
 * an editor. Draws when asked (`render`), at the time given; the pixels
 * come a frame or two later.
 *
 * @example
 * ```ts
 * const preview = new MaterialPreview(backend, meshes);
 * preview.material = new Material({ graph });
 * const pixels = await preview.render(time); // RGBA, rows from the top
 * ```
 */
export class MaterialPreview {
  readonly width: number;
  readonly height: number;
  shape: PreviewShape = 'sphere';
  material: Material | undefined;
  readonly #backend: RenderBackend;
  readonly #renderer: Renderer;
  readonly #runner: RenderGraphRunner;
  readonly #texture: GpuTexture;
  readonly #meshes: PreviewMeshes;
  readonly #camera: Camera;
  readonly #light: DirectionalLight;
  readonly #transform = new Transform();
  #reading = false;

  constructor(
    backend: RenderBackend,
    meshes: PreviewMeshes,
    { size = 256 }: { readonly size?: number } = {},
  ) {
    this.#backend = backend;
    this.#meshes = meshes;
    this.width = size;
    this.height = size;
    this.#renderer = new Renderer(backend, {
      output: { toneMapping: 'neutral', encoding: 'srgb' },
    });
    this.#runner = new RenderGraphRunner(backend);
    this.#texture = backend.textures.createTexture({
      label: 'material preview',
      type: '2d',
      format: 'rgba8unorm',
      dimensions: { width: size, height: size },
      usage: ['render-attachment', 'copy-src'],
    });
    this.#camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 35,
        aspect: 1,
        near: 0.1,
        far: 20,
      },
      position: { x: 0, y: 0.55, z: 2.2 },
      // Down a little, towards the origin.
      rotation: { x: -0.124, y: 0, z: 0, w: 0.992 },
    });
    this.#light = new DirectionalLight({
      direction: { x: -0.5, y: -0.7, z: -0.5 },
      ambient: { x: 0.3, y: 0.32, z: 0.36 },
      diffuse: { x: 1.7, y: 1.6, z: 1.5 },
    });
  }

  /**
   * Draws the material at a time, and reads the image back: RGBA bytes,
   * rows from the top. Undefined without a material, or while the image
   * of the previous call is read.
   */
  async render(time = 0): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const material = this.material;
    if (!material || this.#reading) return undefined;
    const mesh = this.#meshes[this.shape];
    // The plane faces the camera, the cube shows three faces.
    const transform = this.#transform;
    if (this.shape === 'plane') {
      transform.rotation = { x: 0.5, y: 0, z: 0, w: 0.866 };
      transform.scale = { x: 1.3, y: 1.3, z: 1.3 };
    } else if (this.shape === 'cube') {
      transform.rotation = { x: 0.2, y: 0.36, z: -0.08, w: 0.907 };
      transform.scale = { x: 0.8, y: 0.8, z: 0.8 };
    } else {
      transform.rotation = { x: 0, y: 0, z: 0, w: 1 };
      transform.scale = { x: 1.6, y: 1.6, z: 1.6 };
    }
    const graph = new RenderGraph({
      size: { width: this.width, height: this.height },
    });
    this.#renderer.addScenePasses(graph, {
      items: [{ mesh, material, transform, castShadow: false }],
      camera: this.#camera,
      target: graph.importTexture('preview', this.#texture),
      format: 'rgba8unorm',
      lights: [this.#light],
      clearColor: { r: 0.11, g: 0.11, b: 0.12, a: 1 },
      time,
      samples: 1,
      shadows: false,
    });
    this.#runner.execute(graph);
    this.#reading = true;
    try {
      const data = await this.#backend.textures.readTexture(this.#texture);
      return new Uint8Array(data);
    } finally {
      this.#reading = false;
    }
  }

  /** Whether the pipeline of the material is ready (created asynchronously). */
  async whenReady(): Promise<void> {
    await this.#renderer.whenReady();
  }

  destroy(): void {
    this.#runner.destroy();
    this.#texture.destroy();
    this.#renderer.destroy();
  }
}
