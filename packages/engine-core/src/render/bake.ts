import {
  canGenerateMipmaps,
  fullMipLevelCount,
  type GpuTexture,
  type GpuTextureFormat,
} from '@fdw/engine-backend';
import { RenderGraph } from '../graph/RenderGraph';
import { RenderGraphRunner } from '../graph/RenderGraphRunner';
import type { Material } from './Material';
import type { Renderer } from './Renderer';

/** What {@link bakeTexture} renders, and into what. */
export interface BakeTextureOptions {
  /**
   * A material whose graph ends with output.fullscreen: its color at each
   * texel, from screen-uv (0 at the top left, 1 at the bottom right).
   */
  readonly material: Material;
  readonly width: number;
  /** Default: the width. */
  readonly height?: number;
  /** Default 'rgba8unorm'. */
  readonly format?: GpuTextureFormat;
  /**
   * The whole chain of levels, computed from the first one. Default true;
   * ignored for the formats whose levels cannot be computed (see
   * canGenerateMipmaps).
   */
  readonly mipmaps?: boolean;
  readonly label?: string;
}

/**
 * Renders a material once into a new texture, with its levels: an
 * expensive procedural graph (noises of many octaves, warped domains)
 * computed once instead of at each pixel of each frame, then read by other
 * materials as any texture (sampled, repeated, filtered by its levels).
 *
 * Waits for the pipeline of the material, when the renderer creates them
 * asynchronously. The texture is sampled, readable (copy-src) and can be
 * rendered to again; destroy it when it is no longer used.
 *
 * @example
 * ```ts
 * const marble = await bakeTexture(renderer, {
 *   material: new Material({ graph: marbleGraph }),
 *   width: 1024,
 * });
 * material.setValue('marble', marble);
 * ```
 */
export async function bakeTexture(
  renderer: Renderer,
  {
    material,
    width,
    height = width,
    format = 'rgba8unorm',
    mipmaps = true,
    label = 'baked texture',
  }: BakeTextureOptions,
): Promise<GpuTexture> {
  const backend = renderer.backend;
  const dimensions = { width, height };
  const levels =
    mipmaps && canGenerateMipmaps(format) ? fullMipLevelCount(dimensions) : 1;
  const texture = backend.textures.createTexture({
    label,
    type: '2d',
    format,
    dimensions,
    usage: ['sampled', 'render-attachment', 'copy-src', 'copy-dst'],
    mipLevelCount: levels,
  });
  const passes = () => {
    const graph = new RenderGraph({ size: dimensions });
    const color = renderer.addFullscreenPass(graph, label, {
      material,
      target: graph.importTexture(label, texture),
      format,
    });
    if (levels > 1) {
      graph.addMipmapPass(`${label} levels`, color);
    }
    return graph;
  };
  // The pipeline of the material, created by a first graph if needed.
  passes();
  await renderer.whenReady();
  const runner = new RenderGraphRunner(backend);
  try {
    runner.execute(passes());
  } finally {
    runner.destroy();
  }
  return texture;
}
