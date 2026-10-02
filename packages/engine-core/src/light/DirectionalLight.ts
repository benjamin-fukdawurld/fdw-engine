import { DirectionalLightSnapshot, IVec3, Vec3View } from '@fdw/engine-backend';
import { BaseLight } from './BaseLight';

export class DirectionalLight
  extends BaseLight
  implements DirectionalLightSnapshot
{
  private _direction: Vec3View;

  constructor(data?: Partial<DirectionalLightSnapshot>) {
    super(
      'directional',
      new ArrayBuffer(
        BaseLight.bufferSize + 3 * 4 // Vec3 for direction, 3 floats, each float is 4 bytes
      ),
      data
    );
    this._direction = new Vec3View(this._buffer, BaseLight.bufferSize);
    this.direction = data?.direction ?? { x: 0, y: 0, z: -1 };
  }

  public get direction(): Readonly<Vec3View> {
    return Object.freeze(this._direction);
  }

  public set direction(value: Partial<IVec3>) {
    this._direction.x = value.x ?? this._direction.x;
    this._direction.y = value.y ?? this._direction.y;
    this._direction.z = value.z ?? this._direction.z;
    this._version++;
  }
}

export default DirectionalLight;
