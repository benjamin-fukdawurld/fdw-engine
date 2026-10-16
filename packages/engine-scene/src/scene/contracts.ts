import type { RenderSource } from '@fdw/engine-core';
import type { Ray, Volume } from '@fdw/engine-geometry';

// What a scene is, whatever stores it: tools (selection, debug views,
// serialization, occlusion culling) written against these interfaces work
// on any implementation.

/** A node of a scene: a place in a hierarchy, with a world matrix. */
export interface SceneNode {
  // Unique among the nodes alive in the scene.
  readonly id: number;
  name: string;
  readonly parent: SceneNode | undefined;
  readonly children: readonly SceneNode[];
  // Up to date when read.
  readonly worldMatrix: ArrayLike<number>;
  layers: number;
  visible: boolean;
  static: boolean;
  traverse(visit: (node: SceneNode) => void): void;
}

/** Options of the queries of a scene. */
export interface SceneQueryOptions {
  readonly layers?: number;
  readonly hidden?: boolean;
}

/** A scene: a hierarchy of nodes, drawn as a RenderSource, with spatial queries. */
export interface SceneGraph extends RenderSource {
  readonly root: SceneNode;
  find(name: string): SceneNode | undefined;
  raycast(
    ray: Ray,
    visit: (node: SceneNode, distance: number) => boolean | void,
    options?: SceneQueryOptions,
    maxDistance?: number,
  ): void;
  queryVolume(
    volume: Volume,
    visit: (node: SceneNode) => boolean | void,
    options?: SceneQueryOptions,
  ): void;
}
