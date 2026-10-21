---
title: Ocean
description: The sea of @fdw/engine-ocean — the waves (ocean spectrum by FFT on the GPU, Gerstner waves), the grid around the camera, the material of the water, the passes that see through it, and the height of the water for the physics.
sidebar:
  order: 18
---

`@fdw/engine-ocean` draws a sea on every backend, lit by its environment
and the sun, and tells the physics where the water is. The tutorials show
it at work: [the sea and its waves](/fdw-engine/tutorials/ocean/),
[floating objects](/fdw-engine/tutorials/floating-objects/).

| Piece                   | What it is                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `OceanSpectrum`         | The waves of an oceanographic spectrum, computed on the GPU by inverse FFTs, in cascades  |
| `GerstnerWaves`         | Sums of Gerstner waves, evaluated in the vertex shader and on the CPU                     |
| `Ocean`                 | The render item: a grid of rings around the camera, its material, the height of the water |
| `OceanRenderer`         | The passes: the scene, the sky, the sea seeing through to the scene, the tone mapping     |
| `Buoyancy`              | Archimedes for the bodies of `@fdw/engine-physics`, at points, with the drag of the water |
| `createSky`, `skyColor` | A daylight sky in a cube texture, with its levels: what the water reflects                |

## The waves

Both sources give the same eight values at each point (x0, z0) of the still
surface: its displacement (dx, h, dz) and their derivatives (∂h/∂x, ∂h/∂z,
∂dx/∂x, ∂dz/∂z, ∂dx/∂z), from which the normal and the jacobian of the
motion come (`WaveSample`, `sampleNormal`, `sampleJacobian`).

**`OceanSpectrum`** (Tessendorf, _Simulating Ocean Water_):

- `createSpectrum(options)` draws, once on the CPU, a random complex
  amplitude h0(**k**) for each wave vector of each cascade, of variance
  S(**k**) Δk² / 2, S being the spectrum: JONSWAP (wind speed, fetch, peak
  enhancement γ) or Phillips, spread around the wind by cos^2s(θ/2). The
  frequencies are those of deep water, ω = √(g|k|) (with `depth`, √(g|k|
  tanh(|k|d))), rounded to multiples of 2π / `period`: the sea loops.
- `update(time)` runs four compute graphs: the spectrum at that time, then
  the stages of the FFT along the rows then the columns (one dispatch per
  stage, each reading the butterflies of its stage from a storage buffer),
  then the fields. Two real fields share each complex FFT (a + ib, their
  spectra being hermitian): four FFTs for eight fields.
- The cascades are tiles of different sizes (233, 37.7 and 6.3 m by
  default), each keeping the waves of a band of lengths, up to 4 waves
  along the side of the next tile. A cascade whose band would reach beyond
  its shortest wave is refused.
- `displacement` and `derivatives`, two storage buffers of vec4 (cascade,
  row along z, column along x), are what the material reads.
- The CPU side: `fields` (the last displacement read back, or computed by
  `evaluateSpectrum` before the first read or with `readback: false`),
  `sample(x0, z0)`, `heightAt(x, z)`. The FFT of the CPU
  (`inverseFft2d`, `butterflyTables`) is the one of the GPU, run by the
  tests against the GPU on WebGPU, Vulkan and WebGL2.

**`GerstnerWaves`**: a list of `{ direction, wavelength, amplitude,
steepness, phase }`. The horizontal motion of a wave is steepness / (k ×
count): with every steepness at 1, the crests of all the waves pinch to a
point where they meet. The material gets their constants in the code and
their phases in uniforms (`wavePhases0`…, wrapped to [0, 2π) on the CPU: no
precision lost after hours).

## The grid

`clipmapGrid({ cell, levels, size, horizon })`: squares of 2 × `size`
cells, the first of `cell` meters (0.5), each ring around the previous one
with cells twice as large (7 rings: 1 km on each side), then a flat skirt to
the horizon (20 km at least), about 23 000 vertices in all. The `Ocean` moves it
under the camera by steps of the coarsest cell (`grid.step`, 32 m), so that
its vertices stay on the same points of the world. On the outer edge of a
ring, the vertices between two of the next ring are moved onto one of
them: the edges match, without cracks once displaced. The waves fade out of
the vertices before the skirt.

The tessellation of [P3b](/fdw-engine/tutorials/tessellation/) was the other
choice: its patches are fixed in the world, while the sea goes to the
horizon wherever the camera is; the rings follow the camera at no CPU cost.

## The material

`oceanGraph(shader, { refraction, fade })`, on the `WaveShader` of the
waves (`spectrumShader`, `gerstnerShader`): a custom one is possible, with
the same three methods.

- **Vertex stage**: the still point (x0, z0) of the vertex, the waves
  added, each faded with the distance at `fade` times its length (the side
  of its tile for a cascade): beyond, the vertices are too far apart.
- **Fragment stage**: the derivatives at the still point of the pixel; the
  waves shorter than a few pixels fade out, the variance of their slopes
  added to the GGX roughness (α² + 2σ²): the far water turns into a sheen.
- **Light**: the environment reflected (Fresnel of water, F0 = 0.02),
  its level by the roughness; a GGX highlight of the sun; through the
  water, the scene bent by the normal, absorbed by e^(−absorption ×
  depth), and the light scattered by the water; the sun through the
  crests; the foam where the jacobian falls below `foamThreshold` and where
  the water is thinner than `shoreFoam`.
- The uniforms of `WaterLook` (`setLook`), `sunDirection` and `sunColor`
  (`setSun(light, intensity)`), the `environment` cube texture and its
  `environmentLevels`.

## The passes

`OceanRenderer.addPasses(graph, options)` (the options of
`addScenePasses`, plus `ocean`):

| Pass               | Writes                                         | Reads                                |
| ------------------ | ---------------------------------------------- | ------------------------------------ |
| `scene`            | the color (rgba16float), the view depth        | —                                    |
| `ocean background` | the sky where the depth is 0, twice (MRT)      | the color, the depth                 |
| `ocean`            | the sea over one copy, against the scene depth | the other copy, the depth (`inputs`) |

It returns the image, in linear colors; `render` adds the tone mapping
(`neutral` by default) and presents. The backend must render to
rgba16float (all of them do; WebGL2 through `EXT_color_buffer_float`).

## The physics

`ocean.heightAt(x, z)` is the height of the water above a point of the
world: the point of the still surface that the waves move there is found
by six fixed point iterations. For the spectrum, the heights come from the
GPU one frame late (`buffer.read()`, not awaited: the next read starts once
the last one is done).

`new Buoyancy(water, { density, gravity })`, `add(body, { points, volume,
depth, drag })`, `install(scheduler)` (the fixed step, before `physics`).
Each point stands for volume / count; wet over `depth` (the cube root of its
share by default), it pushes up by ρ g V × how wet it is, and drags against
the velocity of the point (v + ω × r) by `drag` × mass / count. `boxPoints`
spreads the points of a box.

## Costs

On the coast of the tutorial (1280 × 720, Vulkan, RTX 2060 SUPER, without
vsync): **3.3 ms a frame with the spectrum, 1.9 ms with six Gerstner
waves** (the coast, nine bodies floating, the readback included). The
spectrum itself, 128 × 128 points and three cascades: **0.16 ms** of GPU per
update (0.65 ms at 256); reading back its 768 KB takes 0.9 ms, without
waiting for it. WebGL2 runs the FFTs by rendering points to textures: 32
draws of 49 152 points per frame, 0.36 s an update on SwiftShader (the
software renderer of the tests).

## Limits

- No view under the water, no wakes, no foam that lasts (the foam is that of
  the frame): later.
- The heights read back are a frame late: a few millimeters, a few
  centimeters in a storm.
- Shadows do not fall on the water, nor do lights other than the sun light
  it.
- The waves are those of deep water: no refraction of the waves by the sea
  floor, no breaking on the beach (the foam and the absorption follow the
  depth, the waves do not).
