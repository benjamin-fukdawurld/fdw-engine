import type {
  GpuSampler,
  GpuTextureFormat,
  RenderBackend,
} from '@fdw/engine-backend';
import {
  type Camera,
  Material,
  type Renderable,
  type RenderGraph,
  type Renderer,
  type TextureHandle,
} from '@fdw/engine-core';
import { type Node, NodeFlags, type SceneItem } from '@fdw/engine-scene';
import {
  BuiltinTypes,
  GraphBuilder,
  type PortHandle,
  std,
} from '@fdw/engine-shader';

/** An RGBA color, its components from 0 to 1. */
export type Rgba = readonly [number, number, number, number];

export interface OutlineOptions {
  /** The objects outlined: their silhouette, seen through the others. */
  readonly items: Iterable<Renderable>;
  readonly camera: Camera;
  /** The image the outline is blended over, and its format. */
  readonly target: TextureHandle;
  readonly format: GpuTextureFormat;
  /** The size of the target, in pixels. */
  readonly size: { readonly width: number; readonly height: number };
  /**
   * In the encoding of the target (sRGB for a surface): it is blended over
   * the image as is. Default orange.
   */
  readonly color?: Rgba;
  /** The width of the line, in pixels. Default 2. */
  readonly width?: number;
  /**
   * Prefix of the names of the passes and of their material: give another
   * one to each outline of a frame (the selection, the hovered object).
   */
  readonly name?: string;
}

/**
 * Draws outlines around objects, over an image: the objects are drawn into
 * a mask (a scene pass without color), then a full screen pass blends a
 * line where the mask has an edge. The silhouette is seen through the
 * objects in front, as in most editors.
 *
 * ```ts
 * const outline = new Outline(renderer, backend);
 * // Each frame, after the scene passes (their color):
 * color = outline.addPasses(graph, {
 *   items: renderablesOf(selection.items),
 *   camera, target: color, format: surface.format, size: { width, height },
 * });
 * ```
 */
export class Outline {
  private readonly _materials = new Map<string, Material>();
  private readonly _sampler: GpuSampler;

  constructor(
    readonly renderer: Renderer,
    backend: RenderBackend,
  ) {
    this._sampler = backend.textures.createSampler({
      label: 'outline mask',
      magFilter: 'linear',
      minFilter: 'linear',
      wrapModeS: 'clamp-to-edge',
      wrapModeT: 'clamp-to-edge',
    });
  }

  /**
   * Adds the passes of an outline to a graph, and returns the version of
   * the target they write (the target as it was, without items: nothing
   * is drawn).
   */
  addPasses(
    graph: RenderGraph,
    {
      items,
      camera,
      target,
      format,
      size,
      color = [1, 0.55, 0.1, 1],
      width = 2,
      name = 'outline',
    }: OutlineOptions,
  ): TextureHandle {
    const list = [...items];
    if (list.length === 0) {
      return target;
    }
    const mask = this.renderer.addScenePasses(graph, {
      name: `${name} mask`,
      items: list,
      camera,
      lights: [],
      shadows: false,
      size,
      outputs: { mask: { format: 'r8unorm', value: 'alpha' } },
    }).outputs.mask;
    const material = this.material(name);
    material.setValue('texel', [1 / size.width, 1 / size.height]);
    material.setValue('color', [...color]);
    material.setValue('width', width);
    return this.renderer.addFullscreenPass(graph, name, {
      material,
      inputs: { mask },
      target,
      format,
      load: 'load',
      blend: true,
    });
  }

  // A material per name: the passes of a frame read their values when the
  // graph runs, after every addPasses().
  private material(name: string): Material {
    let material = this._materials.get(name);
    if (!material) {
      material = new Material({
        graph: outlineGraph(),
        values: { maskSampler: this._sampler },
        label: name,
      });
      this._materials.set(name, material);
    }
    return material;
  }
}

// The line: where the mask is empty but not at `width` pixels around (16
// samples on two rings), the color, by how much the mask is covered there.
function outlineGraph() {
  const g = new GraphBuilder('outline');
  const uv = g.builtin('screen-uv');
  const texel = g.uniform('texel', BuiltinTypes.vec2f);
  const color = g.uniform('color', BuiltinTypes.vec4f, {
    default: [1, 0.55, 0.1, 1],
  });
  const width = g.uniform('width', BuiltinTypes.f32, { default: 2 });
  const texture = g.texture('mask');
  const sampler = g.sampler('maskSampler');
  const read = (offset?: PortHandle) =>
    g
      .call(std.textureSample, {
        texture,
        sampler,
        uv: offset ? g.call(std.add, { a: uv, b: offset }) : uv,
      })
      .swizzle('x');
  const step = g.call(std.mul, { a: texel, b: width });
  let around: PortHandle | number = 0;
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    for (const ring of [0.5, 1]) {
      around = g.call(std.max, {
        a: around,
        b: read(
          g.call(std.mul, {
            a: step,
            b: [Math.cos(angle) * ring, Math.sin(angle) * ring],
          }),
        ),
      });
    }
  }
  const edge = g.call(std.clamp, {
    x: g.call(std.sub, { a: around, b: read() }),
    low: 0,
    high: 1,
  });
  g.fullscreen({
    color: g.call(std.extend, {
      xyz: color.swizzle('rgb'),
      w: g.call(std.mul, { a: edge, b: color.swizzle('a') }),
    }),
  });
  return g.build();
}

/**
 * The render items of nodes and of their descendants, those drawn (not
 * hidden): what an outline draws for a selection of nodes.
 */
export function renderablesOf(nodes: Iterable<Node>): Renderable[] {
  const items = new Set<Renderable>();
  for (const root of nodes) {
    if (!root.alive) {
      continue;
    }
    const { scene } = root;
    scene.flush();
    root.traverse(({ entity }) => {
      if (
        scene.MeshRenderer.has(entity) &&
        !(scene.NodeState.flags[entity] & NodeFlags.HiddenInTree)
      ) {
        items.add(scene.MeshRenderer.item[entity] as SceneItem);
      }
    });
  }
  return [...items];
}
