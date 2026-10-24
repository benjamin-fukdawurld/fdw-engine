import { describe, expect, it } from 'vitest';
import { Transform } from './Transform';
import { TransformLayout, TransformPool } from './TransformPool';

describe('Transform', () => {
  it('reads and writes its values in a block of its pool', () => {
    const pool = new TransformPool();
    const transform = new Transform({ position: { x: 1, y: 2, z: 3 } }, pool);
    expect(transform.pool).toBe(pool);
    const o = transform.index * TransformLayout.stride;
    expect([
      ...pool.data.subarray(
        o + TransformLayout.position,
        o + TransformLayout.position + 3,
      ),
    ]).toEqual([1, 2, 3]);
    transform.scale = { y: 4 };
    expect([transform.scale.x, transform.scale.y, transform.scale.z]).toEqual([
      1, 4, 1,
    ]);
    expect([...transform.rotation.asArray()]).toEqual([0, 0, 0, 1]);
  });

  it('versions every change, even of a single component', () => {
    const transform = new Transform();
    expect(transform.version).toBe(0);
    transform.position = { y: 2 };
    transform.position.x = 5;
    transform.rotation.set([0, 1, 0, 0]);
    expect(transform.version).toBe(3);
    expect([transform.position.x, transform.position.y]).toEqual([5, 2]);
    expect(transform.rotation.y).toBe(1);
  });

  it('keeps its values when its pool grows', () => {
    const pool = new TransformPool({ capacity: 2 });
    const first = new Transform({ position: { x: 7 } }, pool);
    const others = Array.from({ length: 20 }, () => new Transform({}, pool));
    expect(first.position.x).toBe(7);
    expect(others.at(-1)?.scale.z).toBe(1);
  });

  it('gives its block back when disposed', () => {
    const pool = new TransformPool();
    const transform = new Transform({}, pool);
    const index = transform.index;
    transform.dispose();
    transform.dispose();
    expect(pool.size).toBe(0);
    expect(() => transform.position.x).toThrow(/was disposed/);
    expect(new Transform({}, pool).index).toBe(index);
  });
});
