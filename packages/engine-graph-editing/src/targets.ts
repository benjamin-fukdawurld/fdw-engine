import type {
  AnimationGraphData,
  AnimationNodeType,
  Animator,
} from '@fdw/engine-animation';
import type {
  BehaviorGraphData,
  BehaviorNodeType,
  BehaviorSystem,
} from '@fdw/engine-behavior';
import type { Material } from '@fdw/engine-core';
import type { GraphDocument, Registry } from '@fdw/engine-graph';
import type { MaterialGraphData, NodeRegistry } from '@fdw/engine-shader';
import type { GraphKind } from './GraphKind';
import { animationGraphKind } from './kinds/animation';
import { behaviorGraphKind } from './kinds/behavior';
import { materialGraphKind } from './kinds/material';
import type { TargetInfo } from './protocol';

// The graphs a scene lets an editor change while it runs: the material of
// an object, the graph of an animator, the graph of a behavior system
// (design/p19-graph-editor.md §1). The scenes list them (`Scene.graphs`);
// each edit that compiles replaces what runs.

interface TargetBase {
  /** Unique in the scene, kept when the scene is made again. */
  readonly id: string;
  /** What the list of the editors shows. */
  readonly name: string;
}

/** The material of objects of a scene. */
export interface MaterialGraphTarget extends TargetBase {
  readonly kind: 'material';
  /** The material drawn now. */
  material(): Material;
  /** Draws another one: the material with the graph edited (`withGraph`). */
  setMaterial(material: Material): void;
  readonly registry?: NodeRegistry;
  /** The attributes of the meshes it is drawn on: position, normal, uv by default. */
  readonly vertexAttributes?: readonly string[];
}

/** The graph played by animators of a scene. */
export interface AnimationGraphTarget extends TargetBase {
  readonly kind: 'animation';
  graph(): AnimationGraphData;
  /** The animators playing it now, by name (a character, an enemy). */
  animators(): readonly {
    readonly name: string;
    readonly animator: Animator;
  }[];
  /**
   * Plays another graph: in each animator (`setGraph`), and for those made
   * later. @throws when it does not play (a clip missing).
   */
  apply(graph: AnimationGraphData): void;
  readonly registry?: Registry<AnimationNodeType>;
}

/** The graph of a behavior system of a scene. */
export interface BehaviorGraphTarget extends TargetBase {
  readonly kind: 'behavior';
  readonly system: BehaviorSystem<unknown>;
  /** The node types of the application, with the standard ones. */
  readonly registry: Registry<BehaviorNodeType>;
  /** A name for an entity running the graph: `orc 3`. */
  entityName?(entity: number): string;
}

/** A graph of a scene an editor can change while it runs. */
export type GraphTarget =
  MaterialGraphTarget | AnimationGraphTarget | BehaviorGraphTarget;

/** What a scene gives the editors. */
export interface SceneGraphs {
  /** Read again when the scene changes (a game that loads its enemies). */
  readonly graphs?: readonly GraphTarget[];
}

/** A target as the list of the editors shows it. */
export const targetInfo = (target: GraphTarget): TargetInfo => ({
  id: target.id,
  kind: target.kind,
  name: target.name,
});

/** The graph a target runs now. */
export function targetGraph(target: GraphTarget): GraphDocument {
  switch (target.kind) {
    case 'material':
      return target.material().graph;
    case 'animation':
      return target.graph();
    case 'behavior':
      return target.system.graph;
  }
}

/** The kind of graph of a target, with its node types. */
export function targetKind(target: GraphTarget): GraphKind {
  switch (target.kind) {
    case 'material':
      return materialGraphKind(target.registry) as unknown as GraphKind;
    case 'animation':
      return animationGraphKind(target.registry) as unknown as GraphKind;
    case 'behavior':
      return behaviorGraphKind(target.registry) as unknown as GraphKind;
  }
}

/**
 * Runs a graph in a target: the material made again, the animators and the
 * system given the graph. @throws when the target cannot run it.
 */
export function applyGraph(target: GraphTarget, graph: GraphDocument): void {
  switch (target.kind) {
    case 'material':
      target.setMaterial(
        target.material().withGraph(graph as MaterialGraphData),
      );
      return;
    case 'animation':
      target.apply(graph as AnimationGraphData);
      return;
    case 'behavior':
      target.system.setGraph(graph as BehaviorGraphData);
      return;
  }
}

/**
 * A target for the material of items of a list (the render items of a
 * gallery): those drawn with it are drawn with the material edited.
 */
export function itemsMaterialTarget(
  id: string,
  name: string,
  items: readonly { material: Material }[],
  options: Pick<MaterialGraphTarget, 'registry' | 'vertexAttributes'> = {},
): MaterialGraphTarget {
  let current = items[0]?.material;
  if (!current) throw new Error(`No item draws "${name}"`);
  return {
    kind: 'material',
    id,
    name,
    material: () => current as Material,
    setMaterial: (material) => {
      for (const item of items) {
        if (item.material === current) item.material = material;
      }
      current = material;
    },
    ...options,
  };
}

/**
 * A target for the graph of animators made from it: those given now, and
 * those `animators` gives later; `onApply` keeps the graph for those made
 * later.
 */
export function animatorsTarget(
  id: string,
  name: string,
  spec: {
    readonly graph: () => AnimationGraphData;
    readonly animators: () => readonly {
      readonly name: string;
      readonly animator: Animator;
    }[];
    readonly onApply?: (graph: AnimationGraphData) => void;
    readonly registry?: Registry<AnimationNodeType>;
  },
): AnimationGraphTarget {
  return {
    kind: 'animation',
    id,
    name,
    graph: spec.graph,
    animators: spec.animators,
    apply: (graph) => {
      const playing = spec.animators();
      // Checked on the first one before the others change.
      const previous = playing.map(({ animator }) => animator.graph);
      try {
        for (const { animator } of playing) animator.setGraph(graph);
      } catch (error) {
        playing.forEach(({ animator }, i) => animator.setGraph(previous[i]));
        throw error;
      }
      spec.onApply?.(graph);
    },
    ...(spec.registry && { registry: spec.registry }),
  };
}
