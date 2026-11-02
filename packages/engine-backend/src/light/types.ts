import { IVec3, Vec3View } from '../math';

export const LightTypeNames = ['point', 'directional', 'spot'] as const;
export type LightTypeName = (typeof LightTypeNames)[number];
export type LightType = LightTypeName | (string & {});

export type LightColorData = {
  ambient: IVec3;
  diffuse: IVec3;
  specular: IVec3;
};

export const LightColorDataSize = 36 as const; // 3 Vec3s, each with 3 floats, each float is 4 bytes

export type LightAttenuationData = {
  constantAttenuation: number;
  linearAttenuation: number;
  quadraticAttenuation: number;
};

export const LightAttenuationDataSize = 12 as const; // 3 floats, each float is 4 bytes

// The half-angles of the cone of a spot light, in degrees, in [0, 90]: full
// intensity within the inner one, none beyond the outer one.
export type LightCutoffData = {
  innerCutoff: number;
  outerCutoff: number;
};

export const LightCutoffDataSize = 8 as const; // 2 floats, each float is 4 bytes

export type BaseLightData = {
  type: LightType;
} & LightColorData;

export type DirectionalLightData = {
  type: 'directional';
  direction: IVec3;
} & BaseLightData;

export type PointLightData = {
  type: 'point';
  position: IVec3;
} & BaseLightData &
  LightAttenuationData;

export type SpotLightData = {
  type: 'spot';
  position: IVec3;
  direction: IVec3;
} & BaseLightData &
  LightAttenuationData &
  LightCutoffData;

export type LightData = DirectionalLightData | PointLightData | SpotLightData;

export type LightState = {
  version: number;
};

export type BaseLightSnapshot = Readonly<LightState> &
  Readonly<BaseLightData> & {
    ambient: Readonly<Vec3View>;
    diffuse: Readonly<Vec3View>;
    specular: Readonly<Vec3View>;
  };

export type DirectionalLightSnapshot = BaseLightSnapshot & {
  direction: Readonly<Vec3View>;
};

export type PointLightSnapshot = BaseLightSnapshot & {
  position: Readonly<Vec3View>;
} & Readonly<LightAttenuationData>;

export type SpotLightSnapshot = BaseLightSnapshot & {
  position: Readonly<Vec3View>;
  direction: Readonly<Vec3View>;
} & Readonly<LightAttenuationData> &
  Readonly<LightCutoffData>;

export type LightSnapshot =
  DirectionalLightSnapshot | PointLightSnapshot | SpotLightSnapshot;
