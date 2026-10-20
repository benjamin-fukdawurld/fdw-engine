import type { GltfExtension } from '../extension';

/** `KHR_materials_unlit`: the base color only, without lighting. */
export const KHR_materials_unlit: GltfExtension = {
  name: 'KHR_materials_unlit',
  material: (_ext, data) =>
    data.kind === 'pbr' ? { ...data, unlit: true } : data,
};
