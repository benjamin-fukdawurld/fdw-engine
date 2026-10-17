import type { IVec3 } from '@fdw/engine-backend';
import { normalize, poseOfMatrix, type AudioListener } from './api';

const forward0: IVec3 = { x: 0, y: 0, z: -1 };
const up0: IVec3 = { x: 0, y: 1, z: 0 };

/**
 * A listener keeping its pose and handing it to its engine, for the
 * implementations of `AudioEngine`. At the origin, looking along -z, y up.
 */
export class AudioListenerPose implements AudioListener {
  position: Readonly<IVec3> = { x: 0, y: 0, z: 0 };
  forward: Readonly<IVec3> = forward0;
  up: Readonly<IVec3> = up0;

  constructor(private readonly _apply: (listener: AudioListenerPose) => void) {}

  setPose(position: IVec3, forward: IVec3, up: IVec3): void {
    this.position = { x: position.x, y: position.y, z: position.z };
    this.forward = normalize(forward, forward0);
    this.up = normalize(up, up0);
    this._apply(this);
  }

  setMatrix(matrix: ArrayLike<number>): void {
    this.setPose(...poseOfMatrix(matrix));
  }
}
