import type { IVec3, RenderBackend } from '@fdw/engine-backend';
import {
  Animator,
  type AnimationClip,
  type AnimationGraphData,
  type Pose,
  type RootMotionOptions,
  type Skeleton,
} from '@fdw/engine-animation';
import {
  instantiate,
  type Model,
  type ModelInstance,
} from '@fdw/engine-assets';
import type { RenderGraph } from '@fdw/engine-core';
import {
  Shapes,
  type PhysicsCharacter,
  type ScenePhysics,
} from '@fdw/engine-physics';
import type { Node, Scene } from '@fdw/engine-scene';
import { clipsOf, Skinning } from '@fdw/engine-skinning';

/** How an actor is made: its model, its size, its animations. */
export interface ActorOptions {
  readonly model: Model;
  // The model scaled to the size of the game.
  readonly scale?: number;
  // The capsule of its body: `2 × (halfHeight + radius)` tall.
  readonly radius: number;
  readonly halfHeight: number;
  readonly graph: AnimationGraphData;
  // The clips of the model, with their events added.
  readonly clips?: (
    clips: Record<string, AnimationClip>,
    skeleton: Skeleton,
  ) => Record<string, AnimationClip>;
  // The joint whose movement the animations give (see Animator).
  readonly rootMotion?: RootMotionOptions;
}

const gravity = 22;

/**
 * The collision groups of the game: the level (the ground, the trunks),
 * the ragdolls of the fallen, the characters. The ragdolls fall on the
 * level only, and the characters walk through them.
 */
export const Groups = {
  level: 1,
  ragdolls: 2,
  characters: 4,
} as const;

/** What the characters walk against, and the camera stops at. */
export const SolidMask = Groups.level | Groups.characters;

/**
 * A character of the game: a body moved by a character controller (a
 * kinematic capsule), the node of the body under the root (drawn between
 * two steps by ScenePhysics), the model under it turned towards where the
 * character faces, skinned and animated by an animation graph.
 */
export class Actor {
  readonly body: Node;
  readonly visual: Node;
  readonly instance: ModelInstance;
  readonly skinning: Skinning;
  readonly animator: Animator;
  /** The clips it plays, by name (events included). */
  readonly clips: Readonly<Record<string, AnimationClip>>;
  readonly character: PhysicsCharacter;
  readonly radius: number;
  readonly halfHeight: number;
  /** Where it faces: 0 along +z (the models face +z), positive to the left. */
  yaw = 0;
  /** Its vertical speed, in m/s. */
  fall = 0;
  grounded = false;

  constructor(
    backend: RenderBackend,
    scene: Scene,
    readonly physics: ScenePhysics,
    position: IVec3,
    options: ActorOptions,
  ) {
    this.radius = options.radius;
    this.halfHeight = options.halfHeight;
    const center = options.halfHeight + options.radius;
    this.body = scene.root.add({
      position: { x: position.x, y: position.y + center, z: position.z },
    });
    const scale = options.scale ?? 1;
    this.visual = this.body.add({
      position: { y: -center },
      scale: { x: scale, y: scale, z: scale },
    });
    this.instance = instantiate(options.model, scene, { parent: this.visual });
    this.skinning = new Skinning(backend, this.instance, options.model);
    const all = clipsOf(options.model, this.skinning.skeleton);
    this.clips = options.clips
      ? options.clips(all, this.skinning.skeleton)
      : all;
    this.animator = new Animator(options.graph, {
      skeleton: this.skinning.skeleton,
      clips: this.clips,
      ...(options.rootMotion ? { rootMotion: options.rootMotion } : {}),
    });
    this.character = physics.addCharacter(this.body, {
      shape: Shapes.capsule(options.halfHeight, options.radius),
      maxSlope: (42 * Math.PI) / 180,
      stepHeight: 0.4,
      snapToGround: 0.4,
      pushBodies: false,
      groups: Groups.characters,
      mask: SolidMask,
    });
  }

  /** The feet: the bottom of the capsule, as drawn. */
  get feet(): IVec3 {
    const p = this.body.worldPosition;
    return { x: p.x, y: p.y - this.halfHeight - this.radius, z: p.z };
  }

  /** A joint of its skeleton, as a node of the scene. */
  joint(name: string): Node {
    return this.skinning.nodes[this.skinning.skeleton.require(name)];
  }

  /**
   * Moves the body by a horizontal velocity (m/s) for a step, and by
   * `offset` (meters: what its animation moved it), falling or held by the
   * ground: a fixed step system. The ragdolls are not in its way.
   */
  move(
    step: number,
    velocity: { x: number; z: number },
    offset?: { x: number; z: number },
  ): void {
    this.fall = this.grounded
      ? Math.min(this.fall, 0) - gravity * step
      : this.fall - gravity * step;
    const done = this.character.move(
      {
        x: velocity.x * step + (offset?.x ?? 0),
        y: this.fall * step,
        z: velocity.z * step + (offset?.z ?? 0),
      },
      { mask: SolidMask },
    );
    this.grounded = done.grounded;
    if (this.grounded && this.fall < 0) {
      // Held by the ground: a small push down keeps it on slopes.
      this.fall = -2;
    }
  }

  /** Turns towards a direction (on the ground) at `speed` radians per second. */
  face(direction: { x: number; z: number }, step: number, speed = 12): void {
    if (Math.abs(direction.x) + Math.abs(direction.z) < 1e-6) return;
    const target = Math.atan2(direction.x, direction.z);
    let delta = target - this.yaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const turn = Math.min(Math.abs(delta), speed * step);
    this.yaw += Math.sign(delta) * turn;
  }

  /** Where it faces, on the ground. */
  get forward(): { x: number; y: number; z: number } {
    return { x: Math.sin(this.yaw), y: 0, z: Math.cos(this.yaw) };
  }

  /**
   * Plays its animations for a frame and poses its skin: the model turned
   * where it faces. Then draw with addPass in the graph of the frame.
   */
  animate(dt: number): void {
    this.applyPose(this.animator.update(dt));
  }

  /** Poses its skin as given (a ragdoll), the model turned where it faces. */
  applyPose(pose: Pose): void {
    const half = this.yaw / 2;
    this.visual.transform.rotation = {
      x: 0,
      y: Math.sin(half),
      z: 0,
      w: Math.cos(half),
    };
    this.skinning.applyPose(pose).update();
  }

  /** Skins its vertices in the graph of the frame (the compute pass). */
  addPass(graph: RenderGraph): void {
    this.skinning.addPass(graph);
  }

  destroy(): void {
    this.skinning.destroy();
    // The body with its node and the model.
    this.body.remove();
  }
}
