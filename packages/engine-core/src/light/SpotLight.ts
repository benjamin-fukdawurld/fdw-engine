import {
  SpotLightData,
  IVec3,
  LightAttenuationDataSize,
  LightCutoffDataSize,
  SpotLightSnapshot,
  Vec3View,
} from '@fdw/engine-backend';
import { BaseLight } from './BaseLight';
import type { ShadowCaster, ShadowCasterData, ShadowOptions } from './shadow';

// A cutoff, in degrees, in [0, 90].
const clampCutoff = (degrees: number): number =>
  Math.min(Math.max(degrees, 0), 90);

export class SpotLight
  extends BaseLight
  implements SpotLightSnapshot, ShadowCaster
{
  private _position: Vec3View;
  private _direction: Vec3View;

  private _attenuation: DataView<ArrayBuffer>;
  private _cutoff: DataView<ArrayBuffer>;

  // Plain values: { position: { x, y, z }, ambient: … }.
  // Draws the items into a shadow map of the light (see ShadowOptions).
  castShadow: boolean;
  shadow: ShadowOptions;

  constructor(data?: Partial<Omit<SpotLightData, 'type'>> & ShadowCasterData) {
    super(
      'spot',
      new ArrayBuffer(
        BaseLight.bufferSize +
          LightAttenuationDataSize +
          LightCutoffDataSize +
          6 * 4, // 2 Vec3s for position and direction, each with 3 floats, each float is 4 bytes
      ),
      data,
    );
    this._position = this.trackedVec3(BaseLight.bufferSize);
    this.position = data?.position ?? { x: 0, y: 0, z: 0 };
    this._direction = this.trackedVec3(BaseLight.bufferSize + 3 * 4);
    this.direction = data?.direction ?? { x: 0, y: 0, z: -1 };
    this.castShadow = data?.castShadow ?? false;
    this.shadow = data?.shadow ?? {};
    this._attenuation = new DataView(
      this._buffer,
      BaseLight.bufferSize + 6 * 4,
      3 * 4,
    );
    this.constantAttenuation = data?.constantAttenuation ?? 1.0;
    this.linearAttenuation = data?.linearAttenuation ?? 0.0;
    this.quadraticAttenuation = data?.quadraticAttenuation ?? 0.0;
    this._cutoff = new DataView(
      this._buffer,
      BaseLight.bufferSize + 9 * 4,
      2 * 4,
    );
    this.innerCutoff = data?.innerCutoff ?? 0.0;
    this.outerCutoff = data?.outerCutoff ?? 17.5;

    // The initial values are version 0, whatever the light type.
    this._version = 0;
  }

  public get position(): Readonly<Vec3View> {
    return this._position;
  }

  public set position(value: Partial<IVec3>) {
    this._position.x = value.x ?? this._position.x;
    this._position.y = value.y ?? this._position.y;
    this._position.z = value.z ?? this._position.z;
  }

  public get direction(): Readonly<Vec3View> {
    return this._direction;
  }

  public set direction(value: Partial<IVec3>) {
    this._direction.x = value.x ?? this._direction.x;
    this._direction.y = value.y ?? this._direction.y;
    this._direction.z = value.z ?? this._direction.z;
  }

  public get constantAttenuation(): number {
    return this._attenuation.getFloat32(0, true);
  }

  public set constantAttenuation(value: number) {
    this._attenuation.setFloat32(0, value, true);
    this._version++;
  }

  public get linearAttenuation(): number {
    return this._attenuation.getFloat32(4, true);
  }

  public set linearAttenuation(value: number) {
    this._attenuation.setFloat32(4, value, true);
    this._version++;
  }

  public get quadraticAttenuation(): number {
    return this._attenuation.getFloat32(8, true);
  }

  public set quadraticAttenuation(value: number) {
    this._attenuation.setFloat32(8, value, true);
    this._version++;
  }

  /**
   * The half-angle of the cone at full intensity, in degrees: clamped to
   * [0, 90].
   */
  public get innerCutoff(): number {
    return this._cutoff.getFloat32(0, true);
  }

  public set innerCutoff(value: number) {
    this._cutoff.setFloat32(0, clampCutoff(value), true);
    this._version++;
  }

  /**
   * The half-angle of the cone beyond which the light is off, in degrees:
   * clamped to [0, 90] (a wider cone would light behind the light, which
   * its culling volume does not cover).
   */
  public get outerCutoff(): number {
    return this._cutoff.getFloat32(4, true);
  }

  public set outerCutoff(value: number) {
    this._cutoff.setFloat32(4, clampCutoff(value), true);
    this._version++;
  }
}
