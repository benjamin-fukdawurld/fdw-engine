import { bench, describe } from 'vitest';
import { World } from './World';

// The cost of the core: creating entities with components, and a system
// walking 100 000 of them.
const count = 100_000;

const filled = () => {
  const world = new World({ capacity: count });
  const Position = world.defineComponent('position', {
    x: 'f32',
    y: 'f32',
    z: 'f32',
  });
  const Velocity = world.defineComponent('velocity', {
    x: 'f32',
    y: 'f32',
    z: 'f32',
  });
  for (let i = 0; i < count; i++) {
    const entity = world.create();
    world.add(entity, Position);
    world.add(entity, Velocity, { x: 1, y: 0.5, z: 0.25 });
  }
  return { world, Position, Velocity, moving: world.query(Position, Velocity) };
};

const { Position, Velocity, moving } = filled();

describe(`World, ${count} entities`, () => {
  bench(
    'create, with two components',
    () => {
      filled();
    },
    { iterations: 5 },
  );

  bench('system: position += velocity × dt', () => {
    const entities = moving.entities;
    const px = Position.x;
    const py = Position.y;
    const pz = Position.z;
    const vx = Velocity.x;
    const vy = Velocity.y;
    const vz = Velocity.z;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      px[e] += vx[e] * 0.016;
      py[e] += vy[e] * 0.016;
      pz[e] += vz[e] * 0.016;
    }
  });
});
