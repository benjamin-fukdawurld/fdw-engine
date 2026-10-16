import type { GltfExtension } from '../extension';

/** `KHR_materials_emissive_strength`: multiplies the emissive factor, beyond 1 (HDR). */
export const KHR_materials_emissive_strength: GltfExtension = {
  name: 'KHR_materials_emissive_strength',
  material(ext, data) {
    const strength =
      (ext as { emissiveStrength?: number }).emissiveStrength ?? 1;
    const [r, g, b] = data.emissive;
    return { ...data, emissive: [r * strength, g * strength, b * strength] };
  },
};
