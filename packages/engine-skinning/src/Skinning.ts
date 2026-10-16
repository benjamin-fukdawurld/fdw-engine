import { AnimationClip, multiplyMatrix, Skeleton } from '@fdw/engine-animation';
import type { Pose } from '@fdw/engine-animation';
import type { Model, ModelInstance, SkinData } from '@fdw/engine-assets';
import type { GpuBuffer, GpuTexture, RenderBackend } from '@fdw/engine-backend';
import {
  ComputeRunner,
  type Material,
  type Mesh,
  TransformLayout,
} from '@fdw/engine-core';
import { Aabb, invert, maxScale } from '@fdw/engine-geometry';
import type { Node } from '@fdw/engine-scene';
import { compile, type CompiledProgram } from '@fdw/engine-shader';
import type { MaterialGraphData } from '@fdw/engine-shader';
import {
  skinGraph,
  SkinValues,
  skinningKernel,
  type SkinningMode,
} from './graph';
import { bindCenters, MeshSkin } from './MeshSkin';

/** The options of a {@link Skinning}. */
export interface SkinningOptions {
  /**
   * `compute` where the backend has compute shaders and storage buffers,
   * `vertex` elsewhere (WebGL2), by default.
   */
  readonly mode?: SkinningMode;
  /** Runs the kernels in `compute` mode: one per backend by default. */
  readonly compute?: Pick<ComputeRunner, 'dispatch'>;
}

/** The mode a backend skins in by default. */
export function defaultSkinningMode(backend: RenderBackend): SkinningMode {
  const capabilities = backend.capabilities;
  return capabilities?.compute === false ||
    capabilities?.storageBuffers === false
    ? 'vertex'
    : 'compute';
}

const skeletons = new WeakMap<Model, Skeleton>();

/**
 * The skeleton of a model: all its nodes, depth first. Shared by its
 * instances, its clips and its masks.
 */
export function skeletonOf(model: Model): Skeleton {
  let skeleton = skeletons.get(model);
  if (!skeleton) {
    skeleton = Skeleton.fromHierarchy(model.data);
    skeletons.set(model, skeleton);
  }
  return skeleton;
}

/**
 * The animations of a model as clips of its skeleton, by name (`clip 0`,
 * `clip 1`… for those without).
 */
export function clipsOf(
  model: Model,
  skeleton = skeletonOf(model),
): Record<string, AnimationClip> {
  const clips: Record<string, AnimationClip> = {};
  model.data.animations.forEach((data, i) => {
    const name = data.name ?? `clip ${i}`;
    clips[name] = AnimationClip.fromData(data, skeleton, { name });
  });
  return clips;
}

const runners = new WeakMap<RenderBackend, ComputeRunner>();
const kernels = new WeakMap<RenderBackend, Map<string, CompiledProgram>>();
const skinnedGraphs = new WeakMap<
  MaterialGraphData,
  Map<string, MaterialGraphData>
>();

// The graph of a material, skinned: built once per graph, mode and
// attributes, for all the instances.
function skinnedGraph(
  graph: MaterialGraphData,
  mode: SkinningMode,
  skin: MeshSkin,
): MaterialGraphData {
  let graphs = skinnedGraphs.get(graph);
  if (!graphs) {
    skinnedGraphs.set(graph, (graphs = new Map()));
  }
  const key = `${mode}:${skin.attributes.normal}:${skin.attributes.tangent}`;
  let skinned = graphs.get(key);
  if (!skinned) {
    skinned = skinGraph(graph, mode, skin.attributes);
    graphs.set(key, skinned);
  }
  return skinned;
}

/** A primitive drawn skinned: its node, its mesh, its material. */
export interface SkinnedPrimitive {
  readonly node: Node;
  readonly mesh: Mesh;
  /** The material of the model, skinned: one per instance. */
  readonly material: Material;
  /** The material of the model, given back by `destroy`. */
  readonly original: Material;
  /** Its bounds, in the space of its node: around the joints it follows. */
  readonly bounds: Aabb;
  /** Compute: the skinned vertices, `stride` vec4 a vertex. */
  readonly vertices?: GpuBuffer;
}

// A node of the model with a skin: its joints, their matrices, and the
// primitives it draws.
interface SkinnedNode {
  readonly node: Node;
  readonly skin: SkinData;
  readonly inverseBinds: Float32Array;
  // The joints in the bind pose, in the space of the mesh.
  readonly centers: Float64Array;
  // The scene node of each joint of the skin.
  readonly joints: readonly Node[];
  // Column-major, 16 a joint: inverse(node) × joint × inverse bind.
  readonly matrices: Float32Array<ArrayBuffer>;
  readonly texture?: GpuTexture;
  readonly buffer?: GpuBuffer;
  readonly primitives: (SkinnedPrimitive & { readonly meshSkin: MeshSkin })[];
}

const identityBinds = (count: number) => {
  const matrices = new Float32Array(count * 16);
  for (let j = 0; j < count; j++) {
    [0, 5, 10, 15].forEach((i) => (matrices[j * 16 + i] = 1));
  }
  return matrices;
};

/**
 * Skins the meshes of an instance of a model: its nodes with a glTF skin
 * draw a material of their own, deformed by the joints of the skin, which
 * are nodes of the instance. Give a pose to the joints
 * ({@link Skinning.applyPose}, or move them yourself), then
 * {@link Skinning.update} before rendering: the joint matrices go to the
 * GPU, the compute pass skins the vertices (or the vertex stages will),
 * the bounds of the primitives follow the joints.
 *
 * @example
 * ```ts
 * const instance = instantiate(model, scene);
 * const skinning = new Skinning(backend, instance, model);
 * const animator = new Animator(graph, { skeleton: skinning.skeleton, clips: clipsOf(model) });
 * // Each frame:
 * skinning.applyPose(animator.update(dt)).update();
 * renderer.render({ source: scene, camera, surface });
 * ```
 */
export class Skinning {
  readonly mode: SkinningMode;
  /** The skeleton of the model: all its nodes. */
  readonly skeleton: Skeleton;
  /** The node of the instance of each joint of the skeleton. */
  readonly nodes: readonly Node[];
  private readonly _backend: RenderBackend;
  private readonly _skinned: SkinnedNode[] = [];
  private readonly _compute?: Pick<ComputeRunner, 'dispatch'>;
  private readonly _matrix = new Float32Array(16);
  private readonly _box = new Aabb();

  /** @throws when a skinned mesh has no joints or weights. */
  constructor(
    backend: RenderBackend,
    instance: ModelInstance,
    model: Model,
    options: SkinningOptions = {},
  ) {
    this._backend = backend;
    this.mode = options.mode ?? defaultSkinningMode(backend);
    this.skeleton = skeletonOf(model);
    const nodes = instance.nodes;
    this.nodes = Array.from(this.skeleton.sources, (source) => nodes[source]);
    if (this.mode === 'compute') {
      this._compute = options.compute ?? runnerOf(backend);
    }
    const { data, meshes } = model;
    data.nodes.forEach((node, index) => {
      if (node.skin === undefined || node.mesh === undefined) {
        return;
      }
      const skin = data.skins[node.skin];
      if (!skin) {
        throw new Error(`Node ${index} has no skin ${node.skin}`);
      }
      this._skinned.push(
        this.skinNode(nodes[index], skin, meshes[node.mesh] ?? [], nodes),
      );
    });
  }

  /** The primitives drawn skinned. */
  get primitives(): readonly SkinnedPrimitive[] {
    return this._skinned.flatMap((node) => node.primitives);
  }

  private skinNode(
    node: Node,
    skin: SkinData,
    primitives: Model['meshes'][number],
    nodes: readonly Node[],
  ): SkinnedNode {
    const { scene } = node;
    const count = skin.joints.length;
    const inverseBinds = skin.inverseBindMatrices ?? identityBinds(count);
    const matrices = new Float32Array(count * 16);
    const backend = this._backend;
    const label = `${node.name} joints`;
    const texture =
      this.mode === 'vertex'
        ? backend.textures.createTexture({
            label,
            type: '2d',
            format: 'rgba32float',
            dimensions: { width: 4, height: count },
          })
        : undefined;
    const buffer =
      this.mode === 'compute'
        ? backend.buffers.create({
            label,
            size: matrices.byteLength,
            usage: ['storage', 'copy-dst'],
          })
        : undefined;
    // The entities drawing the primitives: the node, or its children for a
    // mesh of several primitives (see instantiate()).
    const candidates = [node, ...node.children];
    const used = new Set<number>();
    const skinned = primitives.map(({ mesh, material }) => {
      const target = candidates.find(
        (candidate) =>
          !used.has(candidate.entity) &&
          scene.MeshRenderer.has(candidate.entity) &&
          scene.MeshRenderer.mesh[candidate.entity] === mesh &&
          scene.MeshRenderer.material[candidate.entity] === material,
      );
      if (!target) {
        throw new Error(`No node of "${node.name}" draws its primitive`);
      }
      used.add(target.entity);
      const meshSkin = MeshSkin.of(mesh);
      const vertices =
        this.mode === 'compute'
          ? backend.buffers.create({
              label: `${target.name} skinned vertices`,
              size: meshSkin.vertexCount * meshSkin.stride * 16,
              usage: ['storage', 'copy-src'],
            })
          : undefined;
      const skinnedMaterial = material.withGraph(
        skinnedGraph(material.graph, this.mode, meshSkin),
        texture
          ? { [SkinValues.jointTexture]: texture }
          : { [SkinValues.vertices]: vertices as GpuBuffer },
      );
      target.setMesh(mesh, skinnedMaterial, {
        castShadow: scene.MeshRenderer.noShadow[target.entity] === 0,
      });
      const bounds = new Aabb();
      target.setBounds(bounds);
      return {
        node: target,
        mesh,
        material: skinnedMaterial,
        original: material,
        bounds,
        meshSkin,
        ...(vertices ? { vertices } : {}),
      };
    });
    return {
      node,
      skin,
      inverseBinds,
      centers: bindCenters(inverseBinds),
      joints: skin.joints.map((joint) => nodes[joint]),
      matrices,
      ...(texture ? { texture } : {}),
      ...(buffer ? { buffer } : {}),
      primitives: skinned,
    };
  }

  /**
   * Gives a pose of the skeleton to the nodes of the instance: their local
   * position, rotation and scale.
   */
  applyPose(pose: Pose): this {
    const nodes = this.nodes;
    if (pose.count !== nodes.length) {
      throw new Error(
        `A pose of ${pose.count} joints for a skeleton of ${nodes.length}`,
      );
    }
    const scene = nodes[0]?.scene;
    if (!scene) {
      return this;
    }
    const data = scene.transforms.data;
    const { translations, rotations, scales } = pose;
    const { position, rotation, scale, stride } = TransformLayout;
    for (let joint = 0; joint < nodes.length; joint++) {
      const entity = nodes[joint].entity;
      const o = entity * stride;
      for (let k = 0; k < 3; k++) {
        data[o + position + k] = translations[joint * 3 + k];
        data[o + scale + k] = scales[joint * 3 + k];
      }
      for (let k = 0; k < 4; k++) {
        data[o + rotation + k] = rotations[joint * 4 + k];
      }
      scene.transforms.touch(entity);
    }
    return this;
  }

  /**
   * After the joints moved, before rendering: computes the joint matrices
   * from the world matrices of the nodes, sends them to the GPU, runs the
   * compute skinning, and updates the bounds of the primitives.
   */
  update(): this {
    const matrix = this._matrix;
    for (const skinned of this._skinned) {
      const inverse = invert(skinned.node.worldMatrix);
      if (!inverse) {
        continue;
      }
      const { matrices, inverseBinds, joints } = skinned;
      for (let j = 0; j < joints.length; j++) {
        multiplyMatrix(
          joints[j].worldMatrix,
          0,
          inverseBinds,
          j * 16,
          matrix,
          0,
        );
        multiplyMatrix(inverse, 0, matrix, 0, matrices, j * 16);
      }
      if (skinned.texture) {
        this._backend.textures.writeTexture(skinned.texture, matrices);
      }
      if (skinned.buffer) {
        skinned.buffer.write(0, matrices.buffer);
      }
      for (const primitive of skinned.primitives) {
        if (this._compute && skinned.buffer && primitive.vertices) {
          const meshSkin = primitive.meshSkin;
          const buffers = meshSkin.buffers(this._backend);
          this._compute.dispatch(kernelOf(this._backend, meshSkin), {
            values: {
              [SkinValues.rest]: buffers.rest,
              [SkinValues.joints]: buffers.joints,
              [SkinValues.weights]: buffers.weights,
              [SkinValues.jointMatrices]: skinned.buffer,
              [SkinValues.vertices]: primitive.vertices,
            },
            workgroups: [Math.ceil(meshSkin.vertexCount / 64)],
          });
        }
        this.updateBounds(skinned, primitive);
      }
    }
    return this;
  }

  // The bounds of a primitive: a sphere per joint moving its vertices,
  // around the joint, of the radius of its vertices in the bind pose,
  // scaled as the joint is. A vertex is a weighted mean of points in them.
  private updateBounds(
    skinned: SkinnedNode,
    primitive: SkinnedNode['primitives'][number],
  ): void {
    const radii = primitive.meshSkin.radii(skinned.inverseBinds);
    const box = this._box.makeEmpty();
    const { matrices, centers } = skinned;
    const point: [number, number, number] = [0, 0, 0];
    for (let j = 0; j < radii.length; j++) {
      const radius = radii[j];
      if (radius < 0) continue;
      const m = matrices.subarray(j * 16, j * 16 + 16);
      // The joint relative to the node: m applied to the joint in the
      // bind pose.
      const [x, y, z] = [
        centers[j * 3],
        centers[j * 3 + 1],
        centers[j * 3 + 2],
      ];
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const r = radius * maxScale(m);
      for (const sign of [-1, 1]) {
        point[0] = cx + sign * r;
        point[1] = cy + sign * r;
        point[2] = cz + sign * r;
        box.expandByPoint(point);
      }
    }
    if (!box.isEmpty()) {
      primitive.bounds.copyFrom(box);
      primitive.node.setBounds(primitive.bounds);
    }
  }

  /**
   * Gives the materials of the model back to the primitives, their bounds
   * back to those of the meshes, and frees the GPU resources of the
   * skinning.
   */
  destroy(): void {
    for (const skinned of this._skinned) {
      for (const primitive of skinned.primitives) {
        if (primitive.node.alive) {
          primitive.node.setMesh(primitive.mesh, primitive.original, {
            castShadow:
              primitive.node.scene.MeshRenderer.noShadow[
                primitive.node.entity
              ] === 0,
          });
          primitive.node.setBounds(undefined);
        }
        primitive.vertices?.destroy();
      }
      skinned.texture?.destroy();
      skinned.buffer?.destroy();
    }
    this._skinned.length = 0;
  }
}

function runnerOf(backend: RenderBackend): ComputeRunner {
  let runner = runners.get(backend);
  if (!runner) {
    runner = new ComputeRunner(backend);
    runners.set(backend, runner);
  }
  return runner;
}

function kernelOf(backend: RenderBackend, skin: MeshSkin): CompiledProgram {
  let compiled = kernels.get(backend);
  if (!compiled) {
    kernels.set(backend, (compiled = new Map()));
  }
  const key = `${skin.attributes.normal}:${skin.attributes.tangent}`;
  let kernel = compiled.get(key);
  if (!kernel) {
    kernel = compile(skinningKernel(skin.attributes), {
      capabilities: backend.capabilities,
    });
    compiled.set(key, kernel);
  }
  return kernel;
}
