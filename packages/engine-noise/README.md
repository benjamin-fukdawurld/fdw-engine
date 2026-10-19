# @fdw/engine-noise

The noises of the material graph, in TypeScript: the same hashes, the same algorithms and the same constants as the `noise.*` functions of `@fdw/engine-shader`, for what the CPU needs to know of a procedural material — the heights of a terrain for the physics, the places of the objects set on it. The rendering tests compare them with the GPU on every backend.

Pure TypeScript, without dependency.

## Public API

| Export                                                   | Description                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pcg`, `pcg2d`, `pcg3d`, `pcg4d`                         | Integer hashes of the PCG family (Jarzynski and Olano 2020), on u32: the bits of the GPU                    |
| `hashCell`, `random`, `toUnit`                           | The hash of the integer cell of a point for a seed, random floats in [0, 1) per cell                        |
| `valueNoise`, `perlinNoise`, `simplexNoise`              | Value, gradient (Perlin) and simplex noises in [-1, 1], of points of 2 to 4 coordinates (the 4th one: time) |
| `worleyNoise`                                            | Cellular noise: the distances to the two nearest feature points, the identifier of the cell of the nearest  |
| `noise`                                                  | A noise by its kind (`'value'`, `'perlin'`, `'simplex'`, `'worley'`)                                        |
| `fbm`, `ridged`, `turbulence`, `fractal`, `octaveWeight` | The fractal sums of a noise, with the octaves finer than a pixel faded out (`footprint`)                    |
| `warp`                                                   | Domain warping: the point moved by a fbm per coordinate                                                     |

## Usage

```ts
import { fbm } from '@fdw/engine-noise';

// The height of a terrain at (x, z), the same as the material computes.
const height = 12 * fbm([x / 60, z / 60], { noise: 'simplex', octaves: 6 });
```

The CPU computes in doubles, the GPU in floats: the values agree to about 1e-5, the hashes bit for bit.
