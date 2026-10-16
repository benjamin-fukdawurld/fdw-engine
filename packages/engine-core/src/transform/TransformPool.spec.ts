import { invert } from '@fdw/engine-geometry';
import { describe, expect, it } from 'vitest';
import { TransformLayout, TransformPool } from './TransformPool';

const { world, normal, position, rotation, scale, stride } = TransformLayout;

// Writes local values into a block.
function setLocal(
  pool: TransformPool,
  index: number,
  p: number[],
  r: number[],
  s: number[],
) {
  const o = index * stride;
  pool.data.set(p, o + position);
  pool.data.set(r, o + rotation);
  pool.data.set(s, o + scale);
  pool.touch(index);
}

const unit = (q: number[]) => {
  const l = Math.hypot(...q);
  return q.map((v) => v / l);
};

describe('TransformPool', () => {
  it('computes the world matrix and the normal matrix of a block', () => {
    const pool = new TransformPool();
    const index = pool.allocate();
    setLocal(pool, index, [1, 2, 3], unit([0.3, -0.5, 0.2, 0.8]), [2, 0.5, 3]);
    pool.updateNormal(index);
    const o = index * stride;
    const m = pool.data.subarray(o + world, o + world + 16);
    // The translation, and the scale of each axis.
    expect([...m.subarray(12, 15)]).toEqual([1, 2, 3]);
    expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(2, 5);
    expect(Math.hypot(m[4], m[5], m[6])).toBeCloseTo(0.5, 5);
    // The normal matrix: the inverse transpose of the 3 × 3 part.
    const inverse = invert(m) as Float64Array;
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) {
        // (M⁻¹)ᵀ at (row, column) is M⁻¹ at (column, row).
        expect(pool.data[o + normal + column * 4 + row]).toBeCloseTo(
          inverse[row * 4 + column],
          5,
        );
      }
      expect(pool.data[o + normal + column * 4 + 3]).toBe(0);
    }
  });

  it('keeps a rotation as its own normal matrix', () => {
    const pool = new TransformPool();
    const index = pool.allocate();
    setLocal(pool, index, [0, 0, 0], unit([0.1, 0.7, -0.3, 0.6]), [1, 1, 1]);
    pool.updateNormal(index);
    const o = index * stride;
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) {
        expect(pool.data[o + normal + column * 4 + row]).toBeCloseTo(
          pool.data[o + world + column * 4 + row],
          6,
        );
      }
    }
  });

  it('versions the changes, and recomputes only after one', () => {
    const pool = new TransformPool();
    const index = pool.allocate();
    const first = pool.worldVersion(index);
    expect(pool.worldVersion(index)).toBe(first);
    pool.touch(index);
    pool.touch(index);
    expect(pool.localVersion(index)).toBe(2);
    expect(pool.isStale(index)).toBe(true);
    expect(pool.worldVersion(index)).toBe(first + 1);
    expect(pool.isStale(index)).toBe(false);
  });

  it('grows by its factor, keeping the blocks', () => {
    const pool = new TransformPool({ capacity: 4, growth: 1.5 });
    const indices = Array.from({ length: 10 }, (_, i) => {
      const index = pool.allocate();
      pool.data[index * stride + position] = i;
      return index;
    });
    // 4, 6, 9, 14.
    expect(pool.capacity).toBe(14);
    expect(
      indices.map((index) => pool.data[index * stride + position]),
    ).toEqual(indices.map((_, i) => i));
    expect(() => new TransformPool({ growth: 1 })).toThrow(/above 1/);
  });

  it('reuses the freed blocks, as identity transforms', () => {
    const pool = new TransformPool();
    const a = pool.allocate();
    setLocal(pool, a, [5, 5, 5], [0, 0, 0, 1], [3, 3, 3]);
    pool.free(a);
    expect(pool.size).toBe(0);
    const b = pool.allocate();
    expect(b).toBe(a);
    const o = b * stride;
    expect([...pool.data.subarray(o + position, o + scale + 3)]).toEqual([
      0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
    ]);
  });

  it('tells its owner about the changes', () => {
    const touched: number[] = [];
    const pool = new TransformPool({ onTouch: (index) => touched.push(index) });
    const index = pool.allocate();
    pool.touch(index);
    expect(touched).toEqual([index]);
  });
});
