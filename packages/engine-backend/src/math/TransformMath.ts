import { PrimitivesAdapter } from './primitives/PrimitivesAdapter';

export class TransformMath {
  primitiveApis: PrimitivesAdapter;

  constructor(primitiveApis: PrimitivesAdapter) {
    this.primitiveApis = primitiveApis;
  }

  getLocalMatrix(
    position: Float32Array,
    rotation: Float32Array,
    scale: Float32Array
  ): Float32Array {
    const translationMatrix = this.primitiveApis.mat4.translate(
      this.primitiveApis.mat4.identity(),
      position
    );
    const rotationMatrix = this.primitiveApis.mat4.fromQuat(rotation);
    const scaleMatrix = this.primitiveApis.mat4.scale(
      this.primitiveApis.mat4.identity(),
      scale
    );

    return this.primitiveApis.mat4.multiply(
      translationMatrix,
      this.primitiveApis.mat4.multiply(rotationMatrix, scaleMatrix)
    );
  }

  getInverseLocalMatrix(localMatrix: Float32Array): Float32Array {
    return this.primitiveApis.mat4.invert(localMatrix);
  }

  getLocalNormalMatrix(localMatrix: Float32Array): Float32Array {
    return this.primitiveApis.mat3.transpose(
      this.primitiveApis.mat3.invert(
        this.primitiveApis.mat3.fromMat4(localMatrix)
      )
    );
  }

  getWorldMatrix(
    localMatrix: Float32Array,
    parentWorldMatrix?: Float32Array
  ): Float32Array {
    if (parentWorldMatrix) {
      return this.primitiveApis.mat4.multiply(parentWorldMatrix, localMatrix);
    }
    return localMatrix;
  }

  getWorldNormalMatrix(
    normalMatrix: Float32Array,
    parentWorldNormalMatrix?: Float32Array
  ): Float32Array {
    if (parentWorldNormalMatrix) {
      return this.primitiveApis.mat3.multiply(
        parentWorldNormalMatrix,
        normalMatrix
      );
    }
    return normalMatrix;
  }
}
