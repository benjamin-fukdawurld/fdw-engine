---
title: Lights and shadows
description: The lights of a frame, how the shading models sum them, and how shadow maps are drawn and read.
sidebar:
  order: 4
---

## Lights

| Light              | Properties                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DirectionalLight` | `direction`; `castShadow`, `shadow`                                                                                                  |
| `PointLight`       | `position`; `constantAttenuation` (1), `linearAttenuation` (0), `quadraticAttenuation` (0)                                           |
| `SpotLight`        | `position`, `direction`, the attenuation, `innerCutoff` (0) and `outerCutoff` (17.5), half-angles in degrees; `castShadow`, `shadow` |

All of them have `ambient`, `diffuse` and `specular` colors, linear, and
possibly above 1. A point or spot light is attenuated by
`1 / (constant + linear × d + quadratic × d²)`; a spot fades from its inner
to its outer angle.

The lights are given to each frame: `render({ lights })`, or
`addScenePasses(graph, { lights })`. The first 16 (`MaxLights`) are used.
Their values go into the `frame` uniforms, written once per frame and view.

## How the models use them

The lit shading models sum the lights, per fragment:

- `phong`: ambient, diffuse (`N·L`) and specular (`(V·R)^shininess`) terms;
- `pbr`: Cook-Torrance with GGX, Smith-Schlick and Schlick Fresnel, as in
  glTF, plus the ambient term.

A custom model reads them with `light.current` and sums with `light.sum`:
the compiler turns the nodes between them into a loop over the lights. See
[A custom shading model](/fdw-engine/tutorials/custom-shading-model/).

## Shadows

With `castShadow: true`, a directional or spot light casts shadows. Each
frame then:

1. **A shadow pass** (`scene shadows`) draws the casters into an **atlas**,
   a depth texture of `shadowAtlasSize` (2048) pixels, split into equal
   tiles, one per light. It uses the **depth-only** variant of the materials:
   no color, only the position, and the discard of masked materials.
2. **The scene passes** read the atlas: the `phong` and `pbr` models multiply
   the direct light of each light by its visibility, from a comparison with
   its shadow map, filtered over 3 × 3 texels (PCF).

The cameras of the lights:

- A **directional light** sees the scene with an orthographic projection,
  covering a sphere: the bounds of the items, or `shadow.bounds`. Its
  position is snapped to the texels of its tile, so the shadows do not
  shimmer as the scene moves. Smaller bounds give sharper shadows.
- A **spot light** sees its cone, with a perspective projection.

What casts shadows:

- items with `castShadow: false` do not, nor transparent items;
- `addScenePasses(graph, { shadows: false })` turns the shadows of a view off;
- point lights do not cast shadows yet.

### Shadow acne

A surface compared with its own depth shadows itself in stripes, the
**shadow acne**. Three offsets fight it:

- the shadow pass applies a **slope-scaled depth bias**;
- `shadow.normalBias` moves the points along their normal before the
  comparison, in texels of the shadow map (1 by default);
- `shadow.bias` lowers their depth, in normalized depth (0 by default).

Too large an offset detaches the shadows from their casters (**peter
panning**). The defaults suit most scenes.

### In a custom model

`light.shadow`, at a `position` and a `normal`, gives the visibility of the
light being summed: 1 lit, 0 in shadow. It reads the atlas when the frame
has shadows (the `shadows` feature, set by the renderer), and is 1
otherwise:

```ts
const visibility = f.call(stdLights.shadow, { position, normal });
```

## Costs

Each light with shadows draws the casters once more. The atlas is shared,
so more lights make smaller tiles: 4 lights in a 2048 atlas get 1024 × 1024
each. Raise `shadowAtlasSize` for sharper shadows, at the cost of memory.
