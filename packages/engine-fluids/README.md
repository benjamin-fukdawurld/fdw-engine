# @fdw/engine-fluids

Fluids simulated on the GPU, in compute graphs, on every backend (WebGPU, Vulkan, WebGL2), pushed by the bodies of the physics and carrying them.

- **Water on a ground** (`ShallowWater`): a field of heights, its columns exchanging water through virtual pipes; ponds, rivers on a relief, ripples, sources and drains. Drawn with the material of the sea of `@fdw/engine-ocean` (`WaterSurface`, through an `OceanRenderer`).
- **Smoke and fire** (`SmokeGrid`): stable fluids on a staggered grid, in 3D or in a plane; emitters, obstacles, vorticity confinement. Drawn by a march through the grid (`SmokeRenderer`), or in its plane (`smokePlaneGraph`).
- **A liquid of particles** (`ParticleFluid`): position-based fluids, the neighbors found by a bitonic sort on the GPU. Drawn in screen space (`ParticleFluidRenderer`).
- **The bodies** (`FluidBodies`): the spheres and boxes of the bodies of `@fdw/engine-physics` in a storage buffer that every fluid reads; the water and the liquid give `heightAt` and `velocityAt` to a `Buoyancy`.
- **A CPU twin** of each step (`stepShallowWater`, `stepSmoke`, `stepParticles`), the reference of the tests.

## Public API

| Export                                                     | Description                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ShallowWater`                                             | Water on a ground: `update(dt, bodies)`, `addSource`, `splash`, `heightAt`, `velocityAt` |
| `WaterSurface`, `heightFieldShader`, `freshWaterLook`      | The water drawn with the material of the sea                                             |
| `SmokeGrid`                                                | Smoke and fire: `update(dt, bodies)`, `addEmitter`, `reset`                              |
| `SmokeRenderer`, `smokeGraph`, `smokePlaneGraph`           | The march through the smoke over a scene; the smoke of a plane on a quad                 |
| `ParticleFluid`                                            | A liquid of particles: `update(dt, bodies)`, `add`, `addBlock`, `heightAt`, `velocityAt` |
| `ParticleFluidRenderer`                                    | The liquid in screen space: depth of the spheres, smoothing, light                       |
| `FluidBodies`                                              | The bodies the fluids feel: `add(body)`, `addShape`, `update()`                          |
| `stepShallowWater`, `stepSmoke`, `stepParticles`           | The steps on the CPU                                                                     |
| `bodiesInGraph`, `bodyDistanceInGraph`, `sampleLattice`, … | The pieces of the graphs, for fluids of one's own                                        |

## Usage

```ts
import { FluidBodies, ShallowWater, WaterSurface } from '@fdw/engine-fluids';
import { Buoyancy, createSky, OceanRenderer } from '@fdw/engine-ocean';

const water = new ShallowWater(backend, {
  resolution: [128, 128],
  cell: 0.25,
  ground: (x, z) => groundAt(x, z),
  level: 2,
});
const bodies = new FluidBodies(backend).add(crate);
const buoyancy = new Buoyancy(water, { density: 1000 });
const surface = new WaterSurface(water, { environment: createSky(backend) });

// Each frame:
bodies.update();
water.update(dt, bodies);
oceanRenderer.render({
  ocean: surface,
  source: scene,
  camera,
  surface: canvas,
});
```

See the tutorials « Water on a ground », « Smoke and fire » and « A liquid of particles », and the guide « Fluids », of the documentation; the design is in [design/p21-fluids.md](../../design/p21-fluids.md).
