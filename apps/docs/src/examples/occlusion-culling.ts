import {
  Camera,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import { OcclusionCulling } from '@fdw/engine-occlusion';
import { Scene } from '@fdw/engine-scene';
import { buildCity, CullingView, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A city of 2304 buildings seen from a street: the buildings along it hide
// almost all the others, which the occlusion culling leaves out. The corner
// shows the culling from above: light what is drawn, red what is hidden.
// Click the canvas to switch the occlusion culling off and on.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const scene = new Scene();
  const city = buildCity(scene, { blocks: 16, block: 42, street: 14 });
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 60,
      aspect: 16 / 9,
      near: 0.5,
      far: 2000,
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });
  const runner = new RenderGraphRunner(backend);
  // One per view: it remembers what the tests of its view found.
  const occlusion = new OcclusionCulling();
  const view = new CullingView(renderer, scene, occlusion, backend);

  let enabled = true;
  canvas.addEventListener('click', () => (enabled = !enabled));

  // Down an avenue, looking left and right.
  const avenue = city.streets[8];
  onFrame((time) => {
    const z = city.half - ((time * 14) % (2 * city.half));
    const yaw = Math.sin(time * 0.4) * 0.6;
    camera.position = { x: avenue, y: 2, z };
    camera.rotation = {
      x: 0,
      y: Math.sin(yaw / 2),
      z: 0,
      w: Math.cos(yaw / 2),
    };
    followAspect(camera, surface);

    const current = surface.getCurrentTarget();
    // The graph knows the size of the frame: the occlusion culling sizes
    // its depth pyramid with it.
    const graph = new RenderGraph({
      size: { width: current.width, height: current.height },
    });
    const main = renderer.addScenePasses(graph, {
      source: scene,
      camera,
      target: graph.importTexture('surface', current),
      format: surface.format,
      clearColor: { r: 0.55, g: 0.68, b: 0.85, a: 1 },
      ...(enabled ? { occlusion } : {}),
    });
    // The view from above, in the corner, after the main view.
    view.add(graph, main.color, surface, { x: avenue, z }, scene.cameraQueries);
    runner.execute(graph);
    surface.present();

    const stats = renderer.stats.get('scene');
    if (stats) {
      info(
        `occlusion ${enabled ? 'on' : 'off'} (click) · ${
          stats.visible
        } drawn, ${stats.occluded} hidden, of ${
          stats.visible + stats.occluded
        } in view`,
      );
    }
  });
};

export default example;
