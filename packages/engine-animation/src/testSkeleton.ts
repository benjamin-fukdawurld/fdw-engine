import { Skeleton } from './Skeleton';

// The skeleton of the tests: root → hips → spine → arm, and hips → leg.
export const testSkeleton = () =>
  new Skeleton([
    { name: 'root' },
    { name: 'hips', parent: 0, translation: [0, 1, 0] },
    { name: 'spine', parent: 1, translation: [0, 0.5, 0] },
    { name: 'arm', parent: 2, translation: [0.3, 0.3, 0] },
    { name: 'leg', parent: 1, translation: [0.1, -0.5, 0] },
  ]);
