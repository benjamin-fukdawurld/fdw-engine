import {
  DirectionalLightData,
  DirectionalLightSnapshot,
  IVec3,
  Vec3View,
} from '@fdw/engine-backend';
import { BaseLight } from './BaseLight';
import type { ShadowCaster, ShadowCasterData, ShadowOptions } from './shadow';

export class DirectionalLight
  extends BaseLight
  implements DirectionalLightSnapshot, ShadowCaster
{
  private _direction: Vec3View;

  // Plain values: { position: { x, y, z }, ambient: … }.
  // Draws the items into a shadow map of the light (see ShadowOptions).
  castShadow: boolean;
  shadow: ShadowOptions;

  constructor(
    data?: Partial<Omit<DirectionalLightData, 'type'>> & ShadowCasterData,
  ) {
    super(
      'directional',
      new ArrayBuffer(
        BaseLight.bufferSize + 3 * 4, // Vec3 for direction, 3 floats, each float is 4 bytes
      ),
      data,
    );
    this._direction = this.trackedVec3(BaseLight.bufferSize);
    this.direction = data?.direction ?? { x: 0, y: 0, z: -1 };
    this.castShadow = data?.castShadow ?? false;
    this.shadow = data?.shadow ?? {};

    // The initial values are version 0, whatever the light type.
    this._version = 0;
  }

  public get direction(): Readonly<Vec3View> {
    return this._direction;
  }

  public set direction(value: Partial<IVec3>) {
    this._direction.x = value.x ?? this._direction.x;
    this._direction.y = value.y ?? this._direction.y;
    this._direction.z = value.z ?? this._direction.z;
  }
}
