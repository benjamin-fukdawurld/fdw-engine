---
title: Colors and HDR
description: Linear colors, sRGB textures, the HDR target, tone mapping and encoding.
sidebar:
  order: 5
---

## Linear colors

The materials compute **linear** colors: values proportional to the light,
where adding two lights adds their colors. Lighting, blending and filtering
are only right in linear values. Screens and images, however, store colors
**encoded** in sRGB, which spends more precision on dark tones.

The engine keeps the two apart:

- **Color textures** use an `-srgb` format (`rgba8unorm-srgb`): the GPU
  decodes them to linear values as it samples them, before filtering.
- **Data textures** — normal maps, roughness, masks — use a linear format
  (`rgba8unorm`): their values are not colors.
- **Colors given to materials** (uniforms, constants) are linear. A color
  picked in sRGB, such as `#ff8000`, is converted first: about
  `((c / 255 + 0.055) / 1.055) ^ 2.4` per component.
- **The output** is encoded once, at the end.

## The output of the renderer

```ts
const renderer = new Renderer(backend, {
  output: { toneMapping: 'aces', encoding: 'srgb' },
});
renderer.render({ items, camera, surface, exposure: 1.5 });
```

| Option        | Values                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `toneMapping` | `none` (default): clamped to 1; `reinhard`; `aces`; `neutral`: Khronos PBR Neutral, which keeps the base colors of materials |
| `encoding`    | `srgb` (default), for display; `linear`, to keep the values (tests, further processing)                                      |
| `exposure`    | Per frame: multiplies the linear colors before the tone mapping. Default 1                                                   |

Tone mapping compresses the unbounded linear values into the range of the
screen, instead of clipping the highlights. Use it as soon as the lights are
strong, or with PBR materials.

## The HDR target

When the backend can render to `rgba16float`, `render()` draws in two steps:

1. the scene, in linear values, into a transient `rgba16float` texture;
2. a `tone mapping` full screen pass: exposure, tone mapping and encoding,
   into the surface.

The transparent materials then **blend in linear values**, as light does.
Without the HDR target, each material applies the output itself, and
transparent materials blend encoded colors: slightly too dark.

| Backend | `rgba16float` render target                 |
| ------- | ------------------------------------------- |
| WebGPU  | Yes                                         |
| Vulkan  | Yes                                         |
| WebGL2  | With the `EXT_color_buffer_float` extension |

`backend.capabilities.renderableFormats` lists them;
`new Renderer(backend, { hdr: false })` turns the HDR target off.

In your own render graph, draw the scene with `linear: true` into an
`rgba16float` texture, and apply the output in your last full screen pass
(see [Post-processing](/fdw-engine/tutorials/post-processing/)). The tone
mapping and encoding operators are function graphs:
`color.toneMapReinhard`, `color.toneMapAces`, `color.toneMapNeutral`,
`color.linearToSrgb`.

## Multisampling

`new Renderer(backend, { samples: 4 })` draws the scene with 4 samples per
pixel into multisampled attachments, resolved into the target at the end of
the scene passes — into the HDR texture when there is one, so the tone
mapping applies to resolved values. WebGL2 clamps the sample count to what
the format allows.
