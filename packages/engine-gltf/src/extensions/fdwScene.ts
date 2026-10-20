import type { GraphMaterialData, GraphMaterialValue } from '@fdw/engine-assets';
import type { GltfExtension } from '../extension';

/**
 * A value of a graph material in a glTF file: its textures are images of
 * the file, by index.
 */
// A texture by its image in the file, or by its URI (made by code, defined
// in the store where the file is read).
export type FdwGraphValue =
  | GraphMaterialValue
  | {
      readonly image: number;
      readonly colorSpace?: 'srgb' | 'linear';
      readonly mips?: 'generate' | 'none' | 'file';
    };

/** `FDW_scene` on a material: the graph material of the engine it stands for. */
export interface FdwSceneMaterial {
  readonly material: Omit<GraphMaterialData, 'values'> & {
    readonly values: Readonly<Record<string, FdwGraphValue>>;
  };
}

/**
 * `FDW_scene`, the extension of the engine: on a material, the graph
 * material the glTF material approximates for other tools, read instead of
 * it; on the nodes (read by the scene loader), the components of the
 * engine and what glTF has no place for.
 */
export const FDW_scene: GltfExtension = {
  name: 'FDW_scene',
  async material(ext, data, context) {
    const material = (ext as Partial<FdwSceneMaterial>).material;
    if (!material || material.kind !== 'graph') return data;
    const values: Record<string, GraphMaterialValue> = {};
    for (const [name, value] of Object.entries(material.values)) {
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'image' in value
      ) {
        const { image, ...options } = value;
        values[name] = { texture: await context.image(image), ...options };
      } else {
        values[name] = value as GraphMaterialValue;
      }
    }
    return { ...material, values };
  },
};
