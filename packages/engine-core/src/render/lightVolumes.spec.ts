import { Frustum } from '@fdw/engine-geometry';
import { describe, expect, it } from 'vitest';
import { SpotLight } from '../light';
import { spotVolume } from './lightVolumes';

describe('spotVolume', () => {
  // A spot at (1, 2, 3) shining along +x, 30° each side, 10 units long.
  const spot = new SpotLight({
    position: { x: 1, y: 2, z: 3 },
    direction: { x: 1, y: 0, z: 0 },
    outerCutoff: 30,
  });
  const volume = spotVolume(spot, 10, new Frustum());
  const at = (distance: number, degrees: number, around = 0) => {
    const a = (degrees * Math.PI) / 180;
    const b = (around * Math.PI) / 180;
    return [
      1 + distance * Math.cos(a),
      2 + distance * Math.sin(a) * Math.cos(b),
      3 + distance * Math.sin(a) * Math.sin(b),
    ] as [number, number, number];
  };

  it('contains the cone, up to the range', () => {
    for (const around of [0, 45, 90, 180, 270]) {
      for (const degrees of [0, 15, 29]) {
        expect(volume.containsPoint(at(9, degrees, around))).toBe(true);
      }
    }
  });

  it('leaves out what is behind, beyond the range, or far off the axis', () => {
    expect(volume.containsPoint([0, 2, 3])).toBe(false);
    expect(volume.containsPoint(at(11, 0))).toBe(false);
    // The pyramid is wider than the cone at its corners, not on its sides.
    expect(volume.containsPoint(at(5, 35, 0))).toBe(false);
    expect(volume.containsPoint(at(5, 35, 90))).toBe(false);
  });
});
