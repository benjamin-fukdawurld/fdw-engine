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

The lights are given to each frame — `render({ lights })`, or
`addScenePasses(graph, { lights })` — or come from the source (the lights
attached to the nodes of a scene). Their values go into the `frame`
uniforms, written once per frame and view.

## Only what the camera sees

A light costs nothing when it cannot change a pixel of the view:

- a directional light always lights the view;
- a point or spot light is used only if its **range** reaches the frustum
  of the camera. Its range is where its attenuation falls below 1/256 of
  its strongest color (`lightRange(light)`); a light without attenuation
  reaches everything;
- of the lights left, 16 at most (`MaxLights`) are used: the directional
  ones, then the others by the light they give to what the camera sees.

`renderer.stats.get('scene')` gives, for the last frame, the number of
lights used, of shadow maps and of shadow casters drawn.

### Not drawing what is in the dark

When every light of a view is bounded (point and spot lights, with an
attenuation), what none of them reaches is black. With
`addScenePasses(graph, { cullUnlit: true })`, it is not drawn: an item is
kept when its box is within the range of a point light, or within the
pyramid around the cone of a spot (`lightReaches(light, box)`). The test is
conservative: an item near the edge of a cone can be drawn, black.

- Materials without lighting (`unlit`) are always drawn: give a glowing
  object an unlit material.
- The **ambient** term of a light does not fade with the distance: an item
  just inside the range gets it, the next one, culled, does not. Give the
  lights of such a scene no ambient, and a black clear color, so that where
  the drawing stops does not show.
- With a directional light, or a light without attenuation, the option does
  nothing.

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
  covering **what the camera sees** (the bounds of the visible items), or
  `shadow.bounds`. Its size changes by steps, and its position by whole
  texels, so the shadows do not shimmer as the camera moves.
- A **spot light** sees its cone, as far as what the camera sees, with a
  perspective projection.

Both reach **towards the light** as far as the scene goes: a tree out of
view whose shadow falls in view casts it; an object whose shadow falls out
of view is not drawn into the shadow map. A light only has a shadow map if
it is used, and if something is visible.

What casts shadows:

- items with `castShadow: false` do not, nor transparent items;
- `addScenePasses(graph, { shadows: false })` turns the shadows of a view off;
- point lights do not cast shadows yet.

### Cascades

A single map covering everything the camera sees spreads its texels over
the whole distance: the shadows near the camera blur. With
`shadow.cascades`, a **directional light** cuts the view of a perspective
camera into slices by depth, each with its own tile of the atlas:

```ts
sun.shadow = { cascades: { count: 4, distance: 120, lambda: 0.75 } };
```

- `count`: 1 to 4 slices; `distance`: how far the shadows reach (the far
  plane by default), fading out over the last 15 %; `lambda`: from even
  slices (0) to slices a constant ratio apart (1).
- The sphere of each slice depends only on the field of view and its
  depths: it keeps its size as the camera turns, and its center moves by
  whole texels. The cascades do not shimmer.
- The shaders choose the cascade of a point by its depth in the view,
  dithering between two near their boundary.
- One light per frame has cascades (the first with them); `bounds` is then
  ignored. The casters of each cascade are queried in its frustum, at the
  levels of detail chosen for the camera.

The values of the cascades are members of the `frame` block
(`cascadeMatrix0..3`, `cascadeRect0..3`, `cascadeSplits`,
`cascadeOffsets`): `cascadeSplits` and `sliceSphere` of `engine-core`
compute them.

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

## Fog

`fog` in the options of the rendering shows the surfaces through a fog:

```ts
renderer.render({
  source: scene,
  camera,
  surface,
  fog: {
    color: { r: 0.5, g: 0.57, b: 0.64 },
    density: 0.012,
    heightFalloff: 0.02,
  },
});
```

The color moves towards that of the fog by 1 − e<sup>−density ×
distance</sup>, the density taken at the middle height of the ray and
falling by e<sup>−heightFalloff × height</sup> above `height`. It is
computed per pixel, on the linear color, before the exposure and the tone
mapping: the color of the fog is a linear color. The renderer compiles it
into the programs of the views with a fog (the `fog` feature): the views
without it cost nothing more. The background is not fogged.

## Costs

Each light with shadows draws the casters once more; a light with
cascades, once per cascade. The casters sharing a mesh and a material are
instanced in the shadow passes too. The atlas is shared,
so more lights make smaller tiles: 4 lights in a 2048 atlas get 1024 × 1024
each. Raise `shadowAtlasSize` for sharper shadows, at the cost of memory.
