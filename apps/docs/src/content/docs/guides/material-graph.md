---
title: Material graph
description: How materials are described, typed, compiled and specialized.
sidebar:
  order: 1
---

Every material, post-processing effect and compute kernel of the engine is
a **graph of typed nodes**, built with `GraphBuilder` from
`@fdw/engine-shader`. The graph is data: it is serialized as JSON, compiled
into a backend-independent program, then translated into the language of
each backend (WGSL, GLSL ES 3.00, HLSL).

## Building a graph

```ts
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';

const g = new GraphBuilder('textured');
const texel = g.call(std.textureSample, {
  texture: g.texture('map'),
  sampler: g.sampler('mapSampler'),
  uv: g.attribute('uv', BuiltinTypes.vec2f),
});
g.surface({
  shadingModel: 'pbr',
  baseColor: texel.swizzle('rgb'),
  roughness: 0.5,
});
const graph = g.build();
```

| Method                                            | Adds                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `g.call(node, inputs, options?)`                  | A node with one output, returned                                                                                           |
| `g.node(node, { inputs, params })`                | A node with several outputs (or none), returned by name                                                                    |
| `g.attribute(semantic, type)`                     | A vertex attribute of the mesh                                                                                             |
| `g.uniform(name, type, { default, slot })`        | A value of the material                                                                                                    |
| `g.texture(name)`, `g.sampler(name)`              | A texture (`dimension: 'cube'` for a cube), a sampler of the material (`comparison: true` for depth tests)                 |
| `g.storage(name, arrayType(element), { access })` | A storage buffer (WebGPU, Vulkan)                                                                                          |
| `g.builtin(name)`                                 | `vertex-index`, `instance-index`, `frag-coord`, `front-facing`, `screen-uv`, `global-invocation-id`…                       |
| `g.engine(name)`                                  | `camera.view`, `camera.projection`, `camera.inverseViewProjection`, `camera.position`, `object.world`, `time`, `exposure`… |
| `g.constant(type, value)`                         | A constant, part of the code                                                                                               |
| `g.parameter(name, default)`                      | A static parameter, read by macros                                                                                         |
| `g.surface(inputs)`                               | The end of a material: a surface and its shading model                                                                     |
| `g.fullscreen({ color })`                         | The end of a full screen pass                                                                                              |
| `g.output(name, value)`                           | A value of the material for the scene outputs declared `'material'` (see the render graph guide)                           |
| `g.target(name, value, location)`                 | An extra color target (1, 2…), with `fullscreen` or the raw stages: several targets in one pass                            |
| `g.compute({ workgroupSize })`, `g.write(…)`      | The end of a compute graph, and its writes                                                                                 |

`build()` validates the whole graph and returns a `MaterialGraphData`:
`serializeGraph()` and `parseGraph()` turn it into JSON and back.

## Types

The types are those of shaders: scalars (`f32`, `i32`, `u32`, `bool`),
vectors, matrices, arrays, textures and samplers (`BuiltinTypes.vec3f`,
`BuiltinTypes.mat4f`…). Each node is checked when it is added, and an error
names the node and the port:

```
error: #n3.b: std.mul: got vec4<f32>, incompatible with vec3<f32> connected to "a"
```

- The only implicit conversion is the **scalar splat**: an `f32` connects to
  a `vec3<f32>` input. Others need a node: `std.convert`, `std.vec3`,
  `std.extend`, or a swizzle.
- **Generic** nodes take the type of their inputs: `std.mul` of an `f32` and
  a `vec3` is a `vec3`.
- **Swizzles** belong to the connections: `texel.swizzle('rgb')`.
- **Resources** are identified by name: two nodes using `'map'` must declare
  the same texture.

## The standard library

| Group       | Nodes                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arithmetic  | `add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `floor`, `fract`, `sqrt`, `pow`, `sin`, `cos`, `saturate`, `clamp`, `mix`, `step`, `smoothstep`                                                                          |
| Vectors     | `dot`, `length`, `normalize`, `cross`, `reflect`, `vec2`, `vec3`, `vec4`, `extend`, `convert`, `transform`, `transform3`                                                                                                  |
| Comparisons | `less`, `lessEqual`, `greater`, `greaterEqual`, `equal`, `notEqual`, `select`                                                                                                                                             |
| Textures    | `textureSample`, `textureSampleLevel`, `textureSampleCompare`, `textureSampleCube`, `textureSampleCubeLevel`; `textureLoad`, `textureLoadDepth`: a texel by its integer coordinates, without sampler (depths, `r32float`) |
| Derivatives | `dpdx`, `dpdy`, `fwidth`: the change from a pixel to the next one (fragment stage only, `y` down)                                                                                                                         |
| Arrays      | `index`, `arrayLength` (storage buffers)                                                                                                                                                                                  |
| Stages      | `perFragment`: what depends on it is computed per pixel                                                                                                                                                                   |
| Lights      | `light.current`, `light.sum`, `light.shadow` (`stdLights`)                                                                                                                                                                |
| Macros      | `staticSwitch`, `optionalAttribute`, `repeat`, `normalMapping`, `bumpMapping`, `parallaxMapping`, `parallaxOcclusionMapping`, `displacement` (`stdMacros`)                                                                |

They are all in `std`, `stdLights` and `stdMacros`; `createStandardRegistry()`
returns a registry of every standard node type.

## Surfaces and shading models

`g.surface()` ends a material. The compiler replaces it with the standard
vertex stage (object, world, then clip space) and the **shading model**,
whose inputs are those of the surface:

| Model   | Inputs, besides `baseColor` and `alpha`                                 |
| ------- | ----------------------------------------------------------------------- |
| `unlit` | —                                                                       |
| `phong` | `emissive`, `normal`, `specular`, `shininess`                           |
| `pbr`   | `emissive`, `normal`, `metallic`, `roughness`, `occlusion` (as in glTF) |

Every surface also takes `positionOffset`, which moves the vertices in
object space. A shading model is a function graph: see
[A custom shading model](/fdw-engine/tutorials/custom-shading-model/). It can
also be called like any function, `g.call('lighting.pbr', inputs)` with
`worldPosition`: a full screen pass lights a G-buffer that way (see
[Deferred rendering](/fdw-engine/tutorials/deferred-rendering/)), with the
camera and the lights of the last scene passes. `camera.positionFromDepth`
(`uv`, `viewDepth`) gives the world position of a pixel from its depth.

## Functions

A function is a graph with `functionInput` and `functionOutput` nodes,
used as a node:

```ts
const f = new GraphBuilder('scale');
const value = f.functionInput('value', BuiltinTypes.vec3f);
const factor = f.functionInput('factor', BuiltinTypes.f32, { default: 2 });
f.functionOutput('result', f.call(std.mul, { a: value, b: factor }));
const scale = defineFunction(f.build(), { id: 'my.scale' });

g.surface({ baseColor: g.call(scale, { value: color }) });
```

The compiler inlines it: the program is the same as with the nodes written
in place. `build()` embeds the functions a graph calls, so its JSON compiles
on its own. Recursion is refused.

## Macros and variants

A **macro** is a node evaluated at compile time, replaced by the nodes it
generates. Macros read **static parameters**: the `features` of the
material, then the `parameter`s declared by the graph, then what the mesh
has (`hasAttribute.<semantic>`).

| Macro                            | Does                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `macro.staticSwitch`             | `ifTrue` or `ifFalse`, from a feature; only one branch is compiled             |
| `macro.optionalAttribute`        | An attribute when the mesh has it, a fallback otherwise                        |
| `macro.repeat`                   | Applies a function `count` times                                               |
| `macro.normalMapping`            | The normal from a normal map, with the tangents of the mesh or the derivatives |
| `macro.bumpMapping`              | The normal tilted by the slopes of a height                                    |
| `macro.parallaxMapping`          | The uv shifted along the view by a height map                                  |
| `macro.parallaxOcclusionMapping` | The uv where the view meets the relief, by `steps` reads                       |
| `macro.displacement`             | The offset of the vertices along their normal, for `positionOffset`            |

See [Surface details](/fdw-engine/tutorials/surface-details/).

Each parameter read becomes part of the **variant key** of the program:
a mesh with colors and one without get two programs only if the graph reads
the colors. Parameters nobody reads make no variants.

## Compilation

`compile(graph, options)` returns a `CompiledProgram`: an intermediate
representation (typed SSA instructions, one list per stage), the layout of
its resources, and a **program key**. The `Renderer` compiles for you; call
`compile` yourself for compute graphs, tools or tests.

1. **Validation** of the graph, and of what the backend supports
   (`capabilities`).
2. **Lowering**: `output.surface` becomes the vertex stage and the shading
   model; `output.fullscreen` a triangle covering the target.
3. **Optimizations**: dead code (unused resources included), constant
   folding, common subexpressions.
4. **Stages**: each value is constant, per draw, per vertex or per fragment.
   A per-vertex value used by the fragment stage is interpolated, computed
   as early as possible; `std.perFragment` keeps a value in the fragment
   stage (lighting, normalization).
5. **Layout**: `frame` (group 0, camera, time, lights), `material`
   (group 1), `object` (group 2: the object table, see
   [Backends](/fdw-engine/guides/backends-and-surfaces/#object-data-and-instancing)),
   then custom slots. `object.world` and `object.normalMatrix` read the row
   of the object drawn; a fragment stage reading them receives the row
   through a flat varying.
6. **Program key**: a hash of the optimized graph, independent of node ids
   and uniform values. Materials with the same graph share their program.

The backends then resolve the layout (bindings, offsets) and generate the
code: `WgslCodegen`, `GlslEsCodegen`, `HlslCodegen`.

## Limits

- At most 16 lights per frame.
- No image-based lighting yet: the ambient term is a color per light.
- Storage buffers hold arrays of scalars, vectors or matrices (no structs),
  and are not available on WebGL2.
- Function inputs have concrete types (no generics), and `textureSample`
  takes 2D textures only.
