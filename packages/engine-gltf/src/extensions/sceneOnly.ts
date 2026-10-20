import type { GltfExtension } from '../extension';

// Extensions read by the scene loader (gltfSceneLoader), from the JSON of
// the file: known to the model loader, which has nothing to do with them.

/** `KHR_physics_rigid_bodies`: the bodies, colliders and triggers of the nodes. */
export const KHR_physics_rigid_bodies: GltfExtension = {
  name: 'KHR_physics_rigid_bodies',
};

/** `KHR_implicit_shapes`: the shapes of the colliders. */
export const KHR_implicit_shapes: GltfExtension = {
  name: 'KHR_implicit_shapes',
};

/**
 * `EXT_mesh_gpu_instancing`: a node drawn at many transforms, read as a
 * batch by the scene loader. A model instantiated draws it once.
 */
export const EXT_mesh_gpu_instancing: GltfExtension = {
  name: 'EXT_mesh_gpu_instancing',
};
