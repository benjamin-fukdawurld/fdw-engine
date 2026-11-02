import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { DirectionalLight } from './DirectionalLight';
import { PointLight } from './PointLight';
import { SpotLight } from './SpotLight';

describe('lights and cameras', () => {
  it('start at version 0', () => {
    expect(new DirectionalLight().version).toBe(0);
    expect(new PointLight().version).toBe(0);
    expect(new SpotLight({ outerCutoff: 30 }).version).toBe(0);
    const camera = new Camera({ position: { x: 1, y: 2, z: 3 } });
    expect(camera.transformVersion).toBe(0);
    expect(camera.projectionVersion).toBe(0);
  });

  it('increment their version when written through their vectors', () => {
    const spot = new SpotLight();
    (spot.position as { x: number }).x = 9;
    expect(spot.position.x).toBe(9);
    expect(spot.version).toBeGreaterThan(0);

    const point = new PointLight();
    (point.diffuse as { y: number }).y = 1;
    expect(point.version).toBeGreaterThan(0);

    const camera = new Camera();
    (camera.rotation as { w: number }).w = 0.5;
    expect(camera.rotation.w).toBe(0.5);
    expect(camera.transformVersion).toBeGreaterThan(0);
  });

  it('increment their version in the setters', () => {
    const light = new DirectionalLight();
    light.direction = { x: 1 };
    expect(light.direction.x).toBe(1);
    expect(light.version).toBeGreaterThan(0);
  });

  it('copies the projection given to a camera', () => {
    const projection = {
      type: 'perspective' as const,
      fov: 60,
      aspect: 1,
      near: 0.1,
      far: 10,
    };
    const camera = new Camera();
    camera.projection = projection;
    expect(camera.projectionVersion).toBe(1);
    projection.fov = 90;
    expect(camera.projection).toMatchObject({ fov: 60 });
    expect(camera.projectionVersion).toBe(1);
  });

  it('clamps the cutoffs of a spot light to [0, 90] degrees', () => {
    const spot = new SpotLight({ innerCutoff: -5, outerCutoff: 120 });
    expect(spot.innerCutoff).toBe(0);
    expect(spot.outerCutoff).toBe(90);
    spot.outerCutoff = 45;
    expect(spot.outerCutoff).toBe(45);
  });
});
