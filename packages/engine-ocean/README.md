# @fdw/engine-ocean

An animated sea on every backend (WebGPU, Vulkan, WebGL2), lit by its environment and the sun, and the height of its water for the physics.

- **The waves**: the ocean spectrum of Tessendorf (JONSWAP or Phillips), turned into heights, motions and slopes by inverse FFTs in compute graphs, in cascades of tiles of different sizes; or sums of Gerstner waves, evaluated in the vertex shader. The same FFT and the same waves on the CPU.
- **The surface**: a grid of rings around the camera (a clipmap), moved by steps of its coarsest cell, without cracks between the rings.
- **The light**: the reflection of the environment (Fresnel), the sun (GGX), the scene behind the water bent and absorbed along the depth of water, the sun through the crests, the foam of the crests (the jacobian of the motion) and of the shores.
- **The physics**: the height of the water above a point, analytic for Gerstner waves, read back from the GPU a frame late for the spectrum; Archimedes at points of the bodies of `@fdw/engine-physics`.

## Public API

| Export                                                          | Description                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `OceanSpectrum`                                                 | The waves of a spectrum on the GPU: `update(time)`, its two storage buffers, `heightAt`          |
| `GerstnerWaves`                                                 | Sums of Gerstner waves: `update(time)`, `sample`, `heightAt`                                     |
| `Ocean`                                                         | The render item: the grid, its material, `update(camera, time)`, `heightAt`, `setLook`, `setSun` |
| `OceanRenderer`                                                 | The passes that see through the water: `addPasses(graph, options)`, `render(options)`            |
| `Buoyancy`, `boxPoints`                                         | Floating bodies: `add(body, { points, volume })`, `install(scheduler)`                           |
| `createSky`, `skyColor`                                         | A daylight sky in a cube texture with its levels, its color in a direction                       |
| `createSpectrum`, `evaluateSpectrum`                            | The waves of a spectrum, and the fields of the sea on the CPU                                    |
| `butterflyTables`, `inverseFft2d`                               | The inverse FFT of the GPU, on the CPU                                                           |
| `oceanGraph`, `spectrumShader`, `gerstnerShader`, `clipmapGrid` | The material, the waves in a graph, the grid                                                     |

## Usage

```ts
import {
  createSky,
  Ocean,
  OceanRenderer,
  OceanSpectrum,
} from '@fdw/engine-ocean';

const sky = createSky(backend);
const ocean = new Ocean({
  waves: new OceanSpectrum(backend, { windSpeed: 10 }),
  environment: sky,
});
const oceanRenderer = new OceanRenderer(new Renderer(backend));

// Each frame:
ocean.update(camera.position, time);
oceanRenderer.render({ ocean, source: scene, camera, surface, time });
```

See the tutorials « The sea and its waves » and « Floating objects », and the guide « Ocean », of the documentation.
