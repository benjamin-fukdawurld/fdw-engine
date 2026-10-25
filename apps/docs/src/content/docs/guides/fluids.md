---
title: Fluids
description: The fluids of @fdw/engine-fluids — water as a field of heights, smoke and fire in a grid of cells, a liquid of particles; the bodies of the physics that push them and that they carry; their rendering, their costs and their limits.
sidebar:
  order: 19
---

`@fdw/engine-fluids` simulates fluids on the GPU, in compute graphs: the
same code on WebGPU, Vulkan and WebGL2 (where the compute graphs run as
draws into textures). The tutorials show each one at work:
[water on a ground](/fdw-engine/tutorials/shallow-water/),
[smoke and fire](/fdw-engine/tutorials/smoke/),
[a liquid of particles](/fdw-engine/tutorials/liquid/).

## Which method

| Method             | Class           | For                                                                        | Not for                                         |
| ------------------ | --------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| A field of heights | `ShallowWater`  | Ponds, rivers on a relief, pools, ripples, wakes; large areas              | Water over water: waterfalls, breaking waves    |
| A grid of cells    | `SmokeGrid`     | Smoke, fire, steam, dust in the air; 2D (a plane) or 3D                    | A free surface (water): the grid has no surface |
| Particles          | `ParticleFluid` | Water that splashes, pours, breaks against walls; a few liters to a few m³ | Large areas: the particles are small and costly |

They share:

- **`FluidBodies`**: the bodies of `@fdw/engine-physics` (their sphere and
  box colliders, the bounds of the others) or shapes moved by the
  application (`addShape`), written once a frame (`update()`) into a
  storage buffer of six `vec4` per shape: center and kind, rotation, size,
  velocity, angular velocity, center of mass. Up to 64 shapes, read by
  every graph in a loop (`bodiesInGraph`, `bodyDistanceInGraph`,
  `bodySpanInGraph`).
- **The rendering of water** of `@fdw/engine-ocean`: the `WaterSurface` of
  a field of heights is drawn with the material of the sea by the
  `OceanRenderer`; the light of the liquid of particles is the same
  (`WaterLook`).
- **The `Buoyancy`** of `@fdw/engine-ocean`, for what floats: a field of
  heights and a liquid of particles give `heightAt` and `velocityAt`, read
  back from the GPU a frame late.
- **A CPU twin** of each step (`stepShallowWater`, `stepSmoke`,
  `stepParticles`): the tests run both and compare them, on every backend.

## `ShallowWater`

The **virtual pipes** method (O'Brien and Hodgins 1995, Mei et al. 2007): a
grid of columns of water over a ground, exchanging water through the four
faces of each cell.

- **State**: `cells` (depth, occupancy, velocity x, velocity z) and `flux`
  (out toward −x, +x, −z, +z, in m³/s), two pairs of storage buffers read
  and written in turn; `surface` (height, slopes, speed, −1 where dry) for
  the rendering.
- **A step**: the fluxes (from the differences of surface, damped, never
  negative, scaled so that no cell gives more water than it has), then the
  depths, the velocities, the sources, the occupancy of the bodies. Mass
  conserving.
- **Steps**: `maxStep = cell / √(g × maxDepth) / 2`; `update(dt)` splits a
  frame into as many.
- **Bodies**: the occupancy of a column is `stiffness` times the part of the
  bodies under its water alone, up to their whole span: it raises the
  surface, the fluxes push the water aside. A column whose occupancy would
  follow its surface exactly rings like a U-tube (no damping helps): with
  `stiffness` k, k / (k + 1) of the displaced water goes aside, stably.
- **Sources**: `addSource({ x, z, radius, rate })`, negative to drain;
  `splash(x, z, radius, volume)` pours a volume in a step. At most 16.
- **Edges**: `'closed'` (walls) or `'open'` (the water leaves as toward a
  dry cell of the same ground).

`WaterSurface(water, { environment })`: a grid of `density` vertices per
cell, its material `oceanGraph` on `heightFieldShader(water)`: the height in
the vertex stage, the slopes in the fragment stage (bilinear), the foam of
the fast water (from `foamSpeed`) through the jacobian, the dry cells
discarded (the `coverage` of the `WaveShader`, a masked material).

## `SmokeGrid`

**Stable fluids** (Stam 1999) on a **staggered grid** (MAC): the velocity
across the faces (a buffer of one entry more along each axis, `faceSize`),
the rest at the centers.

- **State**: `velocity` (faces), `scalars` (density, temperature),
  `pressure` (pressure, divergence), `solids`, `vorticity`; `shade`
  (density, light of the sun, temperature) for the rendering.
- **A frame**: obstacles, advection of the velocity (faces) and of the
  scalars (cells), semi-Lagrangian with a midpoint step; buoyancy, weight,
  emitters, dissipation; vorticity and its confinement; divergence;
  `iterations` steps of Jacobi; projection (free slip along the walls and
  the obstacles); the light toward the sun. 7 + `iterations` dispatches.
- **Boundaries**: `open` faces (pressure 0, the air flows out), the others
  walls; the obstacles of `FluidBodies` move the air with them.
- **Emitters**: spheres, `density`, `temperature`, `velocity`,
  `turbulence` (a rising simplex noise). At most 16.
- **In a plane**: `resolution: [nx, ny, 1]`; drawn by `smokePlaneGraph`.

`SmokeRenderer`: the scene (linear colors, view depth), then a full screen
march per smoke (`addPass`), then the tone mapping. `setSun(smoke, light)`
sets the direction of the light in the grid and its color in the march;
`setLook(smoke, look)` the albedo, the sky, the fire (`SmokeLook`).

## `ParticleFluid`

**Position-based fluids** (Macklin and Müller 2013).

- **State**: `positions`, `velocities` (vec4 per particle), in the order of
  their cells since the last sort; the first `active` are in use.
- **A step**: prediction; keys; bitonic sort (log₂ n (log₂ n + 1) / 2
  dispatches, a buffer of (j, k) per stage); ranges of the cells (cleared,
  then written where the keys change); reorder; `iterations` × (λ, Δp,
  collisions with the box and the bodies); velocities; XSPH viscosity.
- **Neighbors**: the 27 cells around, at most `maxPerCell` (48) particles
  each, two nested loops of the compute graphs.
- **Columns**: a dispatch per column of cells gives the surface and its
  velocity (`columns`), read back for `heightAt` and `velocityAt`.

`ParticleFluidRenderer`: the spheres into a depth of the liquid (masked
quads, `particleDepthGraph`), the bilateral filter (`smoothDepthGraph`,
`smoothing` passes), the light (`liquidShadingGraph`). `addPasses(graph,
{ liquid, camera, color, sceneDepth, depth })` for a render graph of one's
own.

## Costs

The three demos (`basin`, `smoke`, `splash` in `apps/demo` and
`apps/demo-native`), 1280 × 720, Vulkan, RTX 2060 SUPER, without vsync,
everything included (the scene, the physics):

| Demo                                         | ms per frame | Frames per second |
| -------------------------------------------- | ------------ | ----------------- |
| A pond, 128² cells, 5 floating bodies        | 1.4          | 700               |
| Smoke and fire, 48 × 96 × 48 cells           | 4.2          | 238               |
| A tank, 12 100 particles of 2 cm, 2 substeps | 2.8          | 362               |

Under Dawn (WebGPU in a native window): 3.3, 5.5 and 5.8 ms. In WebGL2 the
compute is emulated: the examples of the documentation use fewer cells and
particles there.

## Limits

- **A field of heights** has one height per column: no water over water,
  no breaking wave. Its waves have no momentum of their own (the pipes do
  not carry the velocity along): a wake does not trail behind a boat.
- **The smoke** is as fine as its grid: details smaller than two cells
  blur; a semi-Lagrangian advection diffuses (MacCormack would keep more).
  The grid does not move with the camera.
- **The particles** are not sorted with the bodies: the liquid pushes the
  bodies only through the `Buoyancy` of its columns, which knows one surface
  per column (no liquid inside a hollow body). Their surface is drawn in
  screen space: no reflections of the liquid in the liquid, no foam nor
  spray yet.
- No fluid casts shadows or receives them.
