import { describe, expect, it } from 'vitest';
import { mat3, mat4, quat, vec4 } from './index';
import { TransformMath } from '../TransformMath';
import * as wgpuMatrixPrimitives from './index';

const near = (actual: ArrayLike<number>, expected: ArrayLike<number>) => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 5);
  }
};

// A translation × rotation × scale matrix.
const trs = (t: number[], q: Float32Array, s: number[]): Float32Array =>
  mat4.multiply(
    mat4.fromTranslation(t),
    mat4.multiply(mat4.fromQuat(q), mat4.fromScaling(s)),
  );

const rotationA = quat.fromAxisAngle(new Float32Array([0, 0, 1]), Math.PI / 3);
const rotationB = quat.fromAxisAngle(new Float32Array([1, 0, 0]), -Math.PI / 4);

describe('wgpu-matrix mat4', () => {
  it('reads the rotation of a scaled matrix', () => {
    const m = trs([1, 2, 3], rotationA, [2, 3, 4]);
    near(mat4.getRotation(m), rotationA);
    near(mat4.getScaling(m), [2, 3, 4]);
  });

  it('replaces the rotation, keeping the translation and the scale', () => {
    const m = trs([1, 2, 3], rotationA, [2, 3, 4]);
    near(mat4.setRotation(m, rotationB), trs([1, 2, 3], rotationB, [2, 3, 4]));
  });

  it('replaces the scale, keeping the translation and the rotation', () => {
    const m = trs([1, 2, 3], rotationA, [2, 3, 4]);
    near(
      mat4.setScaling(m, [5, 1, 0.5]),
      trs([1, 2, 3], rotationA, [5, 1, 0.5]),
    );
  });

  it('gives back a scale to a zero column', () => {
    const m = trs([1, 2, 3], quat.identity(), [0, 1, 1]);
    near(
      mat4.setScaling(m, [2, 1, 1]),
      trs([1, 2, 3], quat.identity(), [2, 1, 1]),
    );
  });

  it('writes into out', () => {
    const m = trs([1, 2, 3], rotationA, [2, 3, 4]);
    const out = mat4.create();
    expect(mat4.setRotation(m, rotationB, out)).toBe(out);
    expect(mat4.setScaling(m, [1, 1, 1], out)).toBe(out);
  });
});

describe('wgpu-matrix vec4', () => {
  it('handles the 4 components', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(Array.from(vec4.one())).toEqual([1, 1, 1, 1]);
    expect(vec4.toArray(v)).toEqual([1, 2, 3, 4]);
    expect(Array.from(vec4.fromArray([5, 6, 7, 8]))).toEqual([5, 6, 7, 8]);
    expect(vec4.str(v)).toBe('Vec4(1, 2, 3, 4)');
    expect(vec4.isFinite(new Float32Array([0, 0, 0, Infinity]))).toBe(false);
    expect(vec4.isNaN(new Float32Array([0, 0, 0, NaN]))).toBe(true);
  });
});

describe('wgpu-matrix mat3 and quat', () => {
  it('writes the 9 values of a mat3 into out', () => {
    const out = [9, 9, 9];
    expect(mat3.toArray(mat3.identity(), out)).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    near(
      mat3.fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0],
    );
  });

  it('compares quaternions with a tolerance by default', () => {
    const q = quat.identity();
    const r = new Float32Array([1e-8, 0, 0, 1]);
    expect(quat.equals(q, r)).toBe(true);
  });
});

describe('TransformMath', () => {
  const math = new TransformMath(wgpuMatrixPrimitives);

  it('gives the inverse transpose as the normal matrix', () => {
    const m = trs([1, 2, 3], rotationA, [2, 2, 2]);
    // A uniform scale s: the rotation divided by s.
    const r = mat4.fromQuat(rotationA);
    near(math.getLocalNormalMatrix(m), [
      r[0] / 2,
      r[1] / 2,
      r[2] / 2,
      0,
      r[4] / 2,
      r[5] / 2,
      r[6] / 2,
      0,
      r[8] / 2,
      r[9] / 2,
      r[10] / 2,
      0,
    ]);
  });

  it('gives a zero normal matrix for a scale of 0, not infinities', () => {
    const m = trs([1, 2, 3], rotationA, [0, 1, 1]);
    const normal = math.getLocalNormalMatrix(m);
    expect(normal).toHaveLength(12);
    expect(normal.every((value) => value === 0)).toBe(true);
  });
});
