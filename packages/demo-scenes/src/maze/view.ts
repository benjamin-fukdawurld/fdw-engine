import type { RenderBackend, Surface } from '@fdw/engine-backend';
import {
  Camera,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
  ViewStats,
} from '@fdw/engine-core';
import type { Scene } from '@fdw/engine-scene';
import type { Inset } from './inset';
import type { Level } from './level';
import { TopView, TopViewLayer } from './topView';

/**
 * The frame of the game: the main view of the camera, then an inset in a
 * corner (the top view of the culling, by default), in one render graph.
 */
export class MazeView {
  readonly renderer: Renderer;
  /** The top view of the culling: the inset, unless another is given. */
  readonly topView: TopView;
  private readonly _runner: RenderGraphRunner;

  constructor(
    backend: RenderBackend,
    private readonly _scene: Scene,
    level: Level,
  ) {
    this.renderer = new Renderer(backend, {
      output: { toneMapping: 'neutral', encoding: 'srgb' },
    });
    this.topView = new TopView(this.renderer, _scene, level, backend);
    this._runner = new RenderGraphRunner(backend);
  }

  /** Renders a frame and presents it: returns what the main view drew. */
  render(
    surface: Surface,
    camera: Camera,
    {
      cullUnlit = false,
      background = { r: 0.05, g: 0.06, b: 0.08 },
      inset = this.topView,
    }: {
      cullUnlit?: boolean;
      background?: { r: number; g: number; b: number };
      inset?: Inset;
    } = {},
  ): ViewStats | undefined {
    const graph = new RenderGraph();
    const output = graph.importTexture('surface', surface.getCurrentTarget());
    // The main view sees the level, not the marker of the top view.
    const main = this.renderer.addScenePasses(graph, {
      source: this._scene,
      camera,
      layers: ~TopViewLayer,
      target: output,
      format: surface.format,
      clearColor: { ...background, a: 1 },
      cullUnlit,
    });
    inset.add(graph, main.color, surface);
    this._runner.execute(graph);
    surface.present();
    return this.renderer.stats.get('scene');
  }

  destroy(): void {
    this._runner.destroy();
    this.renderer.destroy();
  }
}
