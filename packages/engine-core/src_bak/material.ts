export const MaterialTypeNames = ['phong'] as const;
export type MaterialTypeName = (typeof MaterialTypeNames)[number];

export type MaterialType = MaterialTypeName | (string & {});

export interface Material {
  type: MaterialType;
}
