import type { RenderBackend, Surface } from '@fdw/engine-backend';
import {
  Camera,
  DirectionalLight,
  Material,
  Renderable,
  Renderer,
  RenderGraph,
  RenderSource,
  TextureHandle,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type { Scene } from '@fdw/engine-scene';
import type { Level } from './level';

// The layer of the things only the top view shows (the marker of the
// camera): the main camera does not see it.
export const TopViewLayer = 0b10;

// A frame around the picture, in uv.
const border = 0.004;

// The material drawing the top view in a corner of the screen: its texture
// inside the rectangle, a dark frame around it, transparent elsewhere.
function insetMaterial(backend: RenderBackend): Material {
  const g = new GraphBuilder('top view inset');
  const uv = g.builtin('screen-uv');
  const rect = g.uniform('rect', BuiltinTypes.vec4f);
  // Where the pixel is in the rectangle, from 0 to 1.
  const local = g.call(std.div, {
    a: g.call(std.sub, { a: uv, b: rect.swizzle('xy') }),
    b: rect.swizzle('zw'),
  });
  // 1 between low and high, on both axes.
  const within = (low: number, high: number) =>
    g.call(std.mul, {
      a: g.call(std.mul, {
        a: g.call(std.step, { edge: low, x: local.swizzle('x') }),
        b: g.call(std.step, { edge: local.swizzle('x'), x: high }),
      }),
      b: g.call(std.mul, {
        a: g.call(std.step, { edge: low, x: local.swizzle('y') }),
        b: g.call(std.step, { edge: local.swizzle('y'), x: high }),
      }),
    });
  const inside = within(0, 1);
  const frame = within(-border * 4, 1 + border * 4);
  const texel = g.call(std.textureSample, {
    texture: g.texture('view'),
    sampler: g.sampler('viewSampler'),
    uv: local,
  });
  g.fullscreen({
    color: g.call(std.extend, {
      xyz: g.call(std.mul, { a: texel.swizzle('rgb'), b: inside }),
      w: g.call(std.max, {
        a: inside,
        b: g.call(std.mul, { a: frame, b: 0.8 }),
      }),
    }),
  });
  return new Material({
    graph: g.build(),
    values: {
      viewSampler: backend.textures.createSampler({
        wrapModeS: 'clamp-to-edge',
        wrapModeT: 'clamp-to-edge',
      }),
    },
  });
}

/**
 * The level seen from above, in a corner of the screen, with only what the
 * main camera retained: the culling, made visible. It reads the last
 * camera query of the scene (NodeState.lastVisible), so it is drawn after
 * the main view, in the same render graph.
 */
export class TopView {
  readonly camera: Camera;
  private readonly _material: Material;
  private readonly _source: RenderSource;
  private readonly _light = new DirectionalLight({
    direction: { x: 0.3, y: -1, z: 0.2 },
    ambient: { x: 0.3, y: 0.3, z: 0.32 },
    diffuse: { x: 0.9, y: 0.9, z: 0.85 },
    specular: { x: 0, y: 0, z: 0 },
  });
  private _stamp = 0;

  constructor(
    private readonly _renderer: Renderer,
    private readonly _scene: Scene,
    level: Level,
    backend: RenderBackend
  ) {
    const extent = Math.max(level.halfWidth, level.halfDepth) * 1.05;
    // Straight down, the whole level in view.
    this.camera = new Camera({
      position: { x: 0, y: 100, z: 0 },
      rotation: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
      projection: {
        type: 'orthographic',
        left: -extent,
        right: extent,
        bottom: -extent,
        top: extent,
        near: 1,
        far: 200,
      },
    });
    this._material = insetMaterial(backend);
    const { lastVisible, layers: layerColumn } = _scene.NodeState;
    // The nodes the main camera kept, and those of the top view only.
    this._source = {
      query: (frustum, layers, visit) =>
        _scene.query(
          frustum,
          layers,
          (item: Renderable) => {
            const entity = (item as unknown as { entity: number }).entity;
            // The nodes of every layer (the default) have this one too:
            // only those of this layer alone are for the top view.
            if (
              lastVisible[entity] === this._stamp ||
              layerColumn[entity] === TopViewLayer
            ) {
              visit(item);
            }
          },
          // Not a camera query: it must not change what was retained.
          'shadow'
        ),
      // A light of its own, from above: the top view shows what was kept,
      // lit or not (in the dark, the scene has no sun).
      lights: () => [this._light],
    };
  }

  /**
   * Adds the top view to a graph, over `target` (the main view, already
   * added): returns the version of the target it writes.
   */
  add(
    graph: RenderGraph,
    target: TextureHandle,
    surface: Surface
  ): TextureHandle {
    // The query the main view just made.
    this._stamp = this._scene.cameraQueries;
    const size = Math.round(Math.min(surface.width, surface.height) * 0.35);
    const view = this._renderer.addScenePasses(graph, {
      name: 'top view',
      source: this._source,
      camera: this.camera,
      target: graph.createTexture('top view', {
        format: 'rgba8unorm',
        size: { width: size, height: size },
      }),
      format: 'rgba8unorm',
      shadows: false,
      clearColor: { r: 0.02, g: 0.02, b: 0.03, a: 1 },
    });
    // In the top right corner, a margin of 2 % around.
    const margin = 0.02;
    const width = size / surface.width;
    const height = size / surface.height;
    this._material.setValue('rect', [
      1 - width - margin,
      margin,
      width,
      height,
    ]);
    return this._renderer.addFullscreenPass(graph, 'top view inset', {
      material: this._material,
      inputs: { view },
      target,
      format: surface.format,
      load: 'load',
      blend: true,
    });
  }
}
