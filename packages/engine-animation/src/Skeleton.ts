import { Pose } from './Pose';

type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];

/** A joint of a {@link Skeleton}: its name, its parent, its rest transform. */
export interface JointDescription {
  readonly name: string;
  /** The index of the parent, before the joint; -1 (or absent) for a root. */
  readonly parent?: number;
  readonly translation?: Vec3;
  /** A quaternion, x y z w. */
  readonly rotation?: Vec4;
  readonly scale?: Vec3;
  /** Where the joint comes from: the index of its node in a model. */
  readonly source?: number;
}

/**
 * A hierarchy of nodes, as a model has: the shape of `ModelData` of
 * engine-assets (a glTF file), without depending on it.
 */
export interface Hierarchy {
  readonly nodes: readonly {
    readonly name?: string;
    readonly translation?: Vec3;
    readonly rotation?: Vec4;
    readonly scale?: Vec3;
    readonly children: readonly number[];
  }[];
  readonly roots: readonly number[];
}

/**
 * The joints an animation moves, parents before children, with their rest
 * pose. Clips, poses and masks are made for a skeleton; a skeleton made
 * from a model knows the node of each joint, which the channels of its
 * clips target.
 */
export class Skeleton {
  readonly names: readonly string[];
  /** The parent of each joint, -1 for the roots. */
  readonly parents: Int32Array;
  /** The pose of the joints when nothing plays. */
  readonly rest: Pose;
  /** The node of each joint in its model, -1 when unknown. */
  readonly sources: Int32Array;
  private readonly _byName = new Map<string, number>();
  private readonly _bySource = new Map<number, number>();

  constructor(joints: readonly JointDescription[]) {
    this.names = joints.map((joint) => joint.name);
    this.parents = new Int32Array(joints.length);
    this.sources = new Int32Array(joints.length);
    this.rest = new Pose(joints.length);
    joints.forEach((joint, index) => {
      const parent = joint.parent ?? -1;
      if (parent >= index || parent < -1) {
        throw new Error(
          `Joint ${index} ("${joint.name}") must come after its parent ${parent}`,
        );
      }
      this.parents[index] = parent;
      this.sources[index] = joint.source ?? -1;
      if (!this._byName.has(joint.name)) {
        this._byName.set(joint.name, index);
      }
      if (joint.source !== undefined) {
        this._bySource.set(joint.source, index);
      }
      if (joint.translation) {
        this.rest.translations.set(joint.translation, index * 3);
      }
      if (joint.rotation) {
        this.rest.rotations.set(joint.rotation, index * 4);
      }
      if (joint.scale) {
        this.rest.scales.set(joint.scale, index * 3);
      }
    });
  }

  /**
   * The skeleton of a model: its nodes in depth-first order from its roots,
   * or from `root` only (a character among others). The joints keep the
   * names and the transforms of the nodes, and know their node
   * ({@link Skeleton.jointOf}).
   */
  static fromHierarchy(
    hierarchy: Hierarchy,
    options: { root?: number } = {},
  ): Skeleton {
    const joints: JointDescription[] = [];
    const visit = (node: number, parent: number) => {
      const data = hierarchy.nodes[node];
      if (!data) {
        throw new Error(`The hierarchy has no node ${node}`);
      }
      const index = joints.length;
      joints.push({
        name: data.name ?? `node ${node}`,
        parent,
        ...(data.translation ? { translation: data.translation } : {}),
        ...(data.rotation ? { rotation: data.rotation } : {}),
        ...(data.scale ? { scale: data.scale } : {}),
        source: node,
      });
      for (const child of data.children) {
        visit(child, index);
      }
    };
    for (const root of options.root !== undefined
      ? [options.root]
      : hierarchy.roots) {
      visit(root, -1);
    }
    return new Skeleton(joints);
  }

  get count(): number {
    return this.names.length;
  }

  /** The joint of this name (the first one), or -1. */
  indexOf(name: string): number {
    return this._byName.get(name) ?? -1;
  }

  /**
   * The joint of this name.
   *
   * @throws when the skeleton has none.
   */
  require(name: string): number {
    const index = this.indexOf(name);
    if (index < 0) {
      throw new Error(`The skeleton has no joint "${name}"`);
    }
    return index;
  }

  /** The joint of a node of the model, or -1. */
  jointOf(source: number): number {
    return this._bySource.get(source) ?? -1;
  }

  /** Whether `joint` is `ancestor` or one of its descendants. */
  isWithin(joint: number, ancestor: number): boolean {
    for (let j = joint; j >= 0; j = this.parents[j]) {
      if (j === ancestor) {
        return true;
      }
    }
    return false;
  }
}
