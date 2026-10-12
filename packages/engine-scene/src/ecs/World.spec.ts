import { describe, expect, it } from 'vitest';
import { not } from './Query';
import { World } from './World';

const setup = (capacity?: number) => {
  const world = new World(capacity ? { capacity } : {});
  const Position = world.defineComponent('position', {
    value: ['f32', 3],
  });
  const Velocity = world.defineComponent('velocity', {
    x: 'f32',
    y: 'f32',
    z: 'f32',
  });
  const Tag = world.defineComponent('tag', { label: 'ref', level: 'u8' });
  return { world, Position, Velocity, Tag };
};

describe('World', () => {
  it('stores the values of components in columns', () => {
    const { world, Position, Velocity, Tag } = setup();
    const a = world.create();
    const b = world.create();
    world.add(a, Position, { value: [1, 2, 3] });
    world.add(a, Velocity, { x: 4 });
    world.add(b, Tag, { label: { name: 'b' }, level: 300 });
    expect([...Position.value.subarray(a * 3, a * 3 + 3)]).toEqual([1, 2, 3]);
    expect([Velocity.x[a], Velocity.y[a]]).toEqual([4, 0]);
    expect(Tag.label[b]).toEqual({ name: 'b' });
    // A u8 wraps, as typed arrays do.
    expect(Tag.level[b]).toBe(44);
    // Writing again keeps the fields left out.
    world.add(a, Velocity, { y: 5 });
    expect([Velocity.x[a], Velocity.y[a]]).toEqual([4, 5]);
  });

  it('gives a component to many entities at once', () => {
    const { world, Position, Tag } = setup(4);
    world.reserve(100);
    const entities = Array.from({ length: 100 }, () => world.create());
    const moving = world.query(Position);
    const added: number[] = [];
    world.onAdded(Position, (entity) => added.push(entity));
    // One already has it: written, but not added again.
    world.add(entities[0], Position, { value: [9, 9, 9] });
    world.addMany(entities, Position, { value: [1, 2, 3] });
    world.addMany(entities, Tag, { label: 'many', level: 7 });
    expect(moving.count).toBe(100);
    expect(added).toHaveLength(100);
    expect(new Set(added).size).toBe(100);
    const last = entities[99];
    expect([...Position.value.subarray(last * 3, last * 3 + 3)]).toEqual([
      1, 2, 3,
    ]);
    expect([...Position.value.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect([Tag.label[last], Tag.level[last]]).toEqual(['many', 7]);
  });

  it('keeps queries up to date', () => {
    const { world, Position, Velocity, Tag } = setup();
    const moving = world.query(Position, Velocity);
    const still = world.query(Position, not(Velocity));
    const entities = Array.from({ length: 6 }, () => world.create());
    entities.forEach((entity) => world.add(entity, Position));
    entities.slice(0, 3).forEach((entity) => world.add(entity, Velocity));
    expect([...moving].sort()).toEqual(entities.slice(0, 3));
    expect([...still].sort()).toEqual(entities.slice(3));
    world.remove(entities[0], Velocity);
    world.add(entities[5], Velocity);
    expect([...moving].sort()).toEqual([entities[1], entities[2], entities[5]]);
    expect(still.has(entities[0])).toBe(true);
    // The same terms give the same query, created with the entities there.
    expect(world.query(Velocity, Position)).toBe(moving);
    const tagged = world.query(Tag);
    world.add(entities[1], Tag);
    expect([...tagged]).toEqual([entities[1]]);
  });

  it('destroys entities with their components, and reuses their index later', () => {
    const { world, Position } = setup();
    const query = world.query(Position);
    const first = world.create();
    world.add(first, Position, { value: [1, 1, 1] });
    const generation = world.generation(first);
    world.destroy(first);
    expect(world.isAlive(first)).toBe(false);
    expect(query.count).toBe(0);
    expect(world.generation(first)).toBe(generation + 1);
    // Reused: alive again, without the components of the destroyed one.
    const second = world.create();
    expect(second).toBe(first);
    expect(world.has(second, Position)).toBe(false);
    world.add(second, Position);
    expect([...Position.value.subarray(second * 3, second * 3 + 3)]).toEqual([
      0, 0, 0,
    ]);
    expect(world.count).toBe(1);
  });

  it('grows its columns, keeping the values', () => {
    const { world, Position, Velocity } = setup(4);
    const query = world.query(Velocity);
    const entities = Array.from({ length: 100 }, (_, i) => {
      const entity = world.create();
      world.add(entity, Velocity, { x: i });
      world.add(entity, Position, { value: [i, i, i] });
      return entity;
    });
    expect(world.capacity).toBeGreaterThanOrEqual(100);
    expect(entities.map((entity) => Velocity.x[entity])).toEqual(
      entities.map((_, i) => i)
    );
    expect(Position.value[99 * 3 + 2]).toBe(99);
    expect(query.count).toBe(100);
  });

  it('calls the listeners of a component', () => {
    const { world, Velocity } = setup();
    const events: string[] = [];
    const stop = world.onAdded(Velocity, (entity) => events.push(`+${entity}`));
    world.onRemoved(Velocity, (entity) =>
      events.push(`-${entity}:${Velocity.x[entity]}`)
    );
    const entity = world.create();
    world.add(entity, Velocity, { x: 2 });
    world.add(entity, Velocity, { x: 3 });
    world.destroy(entity);
    stop();
    world.add(world.create(), Velocity);
    // Added once; removed with its values still readable.
    expect(events).toEqual([`+${entity}`, `-${entity}:3`]);
  });

  it('matches the queries of exclusions only', () => {
    const { world, Tag } = setup();
    const untagged = world.query(not(Tag));
    const a = world.create();
    const b = world.create();
    world.add(b, Tag);
    expect([...untagged]).toEqual([a]);
    world.destroy(a);
    expect(untagged.count).toBe(0);
  });

  it('refuses the reserved field names and dead entities', () => {
    const { world, Velocity } = setup();
    expect(() => world.defineComponent('bad', { count: 'u32' })).toThrow(
      /"count" is a reserved name/
    );
    const entity = world.create();
    world.destroy(entity);
    expect(() => world.add(entity, Velocity)).toThrow(/is not alive/);
  });
});
