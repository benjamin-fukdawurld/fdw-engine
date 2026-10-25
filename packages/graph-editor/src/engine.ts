import { createCube, createPlane, createSphere } from '@fdw/demo-scenes';
import type { EngineExtensionFactory } from '@fdw/editor-ui/engine';
import {
  type GraphRequest,
  GraphWorkspace,
  type GraphWorkspaceOptions,
} from '@fdw/engine-graph-editing';

/** The id of the part of the editors of graphs in the engine. */
export const graphsExtensionId = 'fdw.graphs';

// How often the graphs of the scene are read again (a game that loads its
// characters lists them later), in seconds.
const targetsPeriod = 0.5;

/**
 * The part of the editors of graphs that runs with the engine: a
 * GraphWorkspace (`@fdw/engine-graph-editing`) on the graphs of the scene
 * shown (`Scene.graphs`), its previews drawn by the backend of the engine.
 * A host gives it to its engine (`EditorEnginePlatform.extensions`); the
 * plugins of the materials, the animations and the behaviors talk to it.
 *
 * @example
 * ```ts
 * new EditorEngine({ ...platform, extensions: [graphsExtension()] }, scene);
 * ```
 */
export function graphsExtension(
  options: Pick<GraphWorkspaceOptions, 'registries'> = {},
): EngineExtensionFactory {
  return {
    id: graphsExtensionId,
    create: ({ backend, post }) => {
      const workspace = new GraphWorkspace({
        post,
        backend,
        meshes: {
          sphere: createSphere(64, 32),
          cube: createCube(),
          plane: createPlane(),
        },
        ...options,
      });
      let scene: { readonly graphs?: GraphWorkspace['targets'] } | undefined;
      let read = -Infinity;
      return {
        receive: (message) => workspace.receive(message as GraphRequest),
        scene: (shown) => {
          scene = shown;
          read = -Infinity;
          workspace.setTargets(shown?.graphs ?? []);
        },
        frame: (time) => {
          if (time - read >= targetsPeriod) {
            read = time;
            workspace.setTargets(scene?.graphs ?? []);
          }
          workspace.frame(time);
        },
        get holdsScene() {
          return workspace.paused;
        },
        dispose: () => workspace.dispose(),
      };
    },
  };
}
