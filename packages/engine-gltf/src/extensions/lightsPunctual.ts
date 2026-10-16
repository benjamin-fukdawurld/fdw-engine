import type { LightData } from '@fdw/engine-assets';
import type { GltfExtension } from '../extension';

interface GltfLight {
  readonly name?: string;
  readonly type: 'directional' | 'point' | 'spot';
  readonly color?: readonly [number, number, number];
  readonly intensity?: number;
  readonly range?: number;
  readonly spot?: {
    readonly innerConeAngle?: number;
    readonly outerConeAngle?: number;
  };
}

/** `KHR_lights_punctual`: the lights of the root object, and the light of each node. */
export const KHR_lights_punctual: GltfExtension = {
  name: 'KHR_lights_punctual',
  node: (ext, data) => {
    const light = (ext as { light?: number }).light;
    return light !== undefined ? { ...data, light } : data;
  },
  model(ext, data) {
    const lights = (
      (ext as { lights?: readonly GltfLight[] }).lights ?? []
    ).map((light): LightData => ({
      type: light.type,
      ...(light.name !== undefined ? { name: light.name } : {}),
      color: light.color ?? [1, 1, 1],
      intensity: light.intensity ?? 1,
      ...(light.range !== undefined ? { range: light.range } : {}),
      ...(light.type === 'spot'
        ? {
            innerConeAngle: light.spot?.innerConeAngle ?? 0,
            outerConeAngle: light.spot?.outerConeAngle ?? Math.PI / 4,
          }
        : {}),
    }));
    return { ...data, lights };
  },
};
