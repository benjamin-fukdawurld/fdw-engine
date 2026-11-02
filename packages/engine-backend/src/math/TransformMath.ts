import { PrimitivesAdapter } from './primitives/PrimitivesAdapter';
import { writeNormalMatrix } from './normalMatrix';

export class TransformMath {
  primitiveApis: PrimitivesAdapter;

  constructor(primitiveApis: PrimitivesAdapter) {
    this.primitiveApis = primitiveApis;
  }

  getLocalMatrix(
    position: Float32Array,
    rotation: Float32Array,
    scale: Float32Array,
  ): Float32Array {
    const translationMatrix = this.primitiveApis.mat4.translate(
      this.primitiveApis.mat4.identity(),
      position,
    );
    const rotationMatrix = this.primitiveApis.mat4.fromQuat(rotation);
    const scaleMatrix = this.primitiveApis.mat4.scale(
      this.primitiveApis.mat4.identity(),
      scale,
    );

    return this.primitiveApis.mat4.multiply(
      translationMatrix,
      this.primitiveApis.mat4.multiply(rotationMatrix, scaleMatrix),
    );
  }

  getInverseLocalMatrix(localMatrix: Float32Array): Float32Array {
    return this.primitiveApis.mat4.invert(localMatrix);
  }

  // As 3 columns of 4 floats; zero for a singular matrix (a scale of 0),
  // as the normal matrices of the transform pools.
  getLocalNormalMatrix(localMatrix: Float32Array): Float32Array {
    const out = new Float32Array(12);
    writeNormalMatrix(localMatrix, 0, out, 0);
    return out;
  }

  getWorldMatrix(
    localMatrix: Float32Array,
    parentWorldMatrix?: Float32Array,
  ): Float32Array {
    if (parentWorldMatrix) {
      return this.primitiveApis.mat4.multiply(parentWorldMatrix, localMatrix);
    }
    return localMatrix;
  }

  getWorldNormalMatrix(
    normalMatrix: Float32Array,
    parentWorldNormalMatrix?: Float32Array,
  ): Float32Array {
    if (parentWorldNormalMatrix) {
      return this.primitiveApis.mat3.multiply(
        parentWorldNormalMatrix,
        normalMatrix,
      );
    }
    return normalMatrix;
  }
}
