import type { GltfExtension } from '../extension';
import { KHR_draco_mesh_compression } from './dracoMeshCompression';
import { KHR_materials_emissive_strength } from './emissiveStrength';
import { FDW_scene } from './fdwScene';
import { KHR_lights_punctual } from './lightsPunctual';
import { KHR_mesh_quantization } from './meshQuantization';
import { EXT_meshopt_compression } from './meshoptCompression';
import {
  EXT_mesh_gpu_instancing,
  KHR_implicit_shapes,
  KHR_physics_rigid_bodies,
} from './sceneOnly';
import { KHR_texture_basisu } from './textureBasisu';
import { KHR_texture_transform } from './textureTransform';
import { KHR_materials_unlit } from './unlit';

export * from './fdwScene';
export {
  EXT_mesh_gpu_instancing,
  EXT_meshopt_compression,
  FDW_scene,
  KHR_implicit_shapes,
  KHR_physics_rigid_bodies,
  KHR_draco_mesh_compression,
  KHR_lights_punctual,
  KHR_materials_emissive_strength,
  KHR_materials_unlit,
  KHR_mesh_quantization,
  KHR_texture_basisu,
  KHR_texture_transform,
};

/** The extensions the loader knows by default. */
export const gltfExtensions: readonly GltfExtension[] = [
  KHR_materials_unlit,
  KHR_materials_emissive_strength,
  KHR_texture_transform,
  KHR_texture_basisu,
  KHR_mesh_quantization,
  KHR_lights_punctual,
  EXT_meshopt_compression,
  KHR_draco_mesh_compression,
  FDW_scene,
  KHR_physics_rigid_bodies,
  KHR_implicit_shapes,
  EXT_mesh_gpu_instancing,
];
