import { ProjectionData } from '../camera/types';
import { Mat4 } from './primitives';
import { PrimitivesAdapter } from './primitives/PrimitivesAdapter';

export class CameraMath {
  primitiveApis: PrimitivesAdapter;

  constructor(primitiveApis: PrimitivesAdapter) {
    this.primitiveApis = primitiveApis;
  }

  getViewMatrix(position: Float32Array, rotation: Float32Array): Mat4 {
    const worldMatrix = this.primitiveApis.mat4.multiply(
      this.primitiveApis.mat4.translate(
        this.primitiveApis.mat4.identity(),
        position
      ),
      this.primitiveApis.mat4.fromQuat(rotation)
    );

    return this.primitiveApis.mat4.invert(worldMatrix);
  }

  getProjectionMatrix(projection: ProjectionData): Mat4 {
    if (projection.type === 'perspective') {
      return this.primitiveApis.mat4.perspective(
        (projection.fov * Math.PI) / 180,
        projection.aspect,
        projection.near,
        projection.far
      );
    }

    return this.primitiveApis.mat4.ortho(
      projection.left,
      projection.right,
      projection.bottom,
      projection.top,
      projection.near,
      projection.far
    );
  }

  getViewProjectionMatrix(viewMatrix: Mat4, projectionMatrix: Mat4): Mat4 {
    return this.primitiveApis.mat4.multiply(projectionMatrix, viewMatrix);
  }
}
