# @fdw/engine-shader

Material graph of FdwEngine: a backend-agnostic description of materials as a directed acyclic graph (DAG) of typed nodes.

This package is pure TypeScript, with no GPU dependency. It implements the design described in [design/material-graph.md](../../design/material-graph.md): the type system, the graph model, the standard node library, type inference, validation, serialization, and the compiler that turns a graph into a backend-independent program (IR + resource layout). Code generators live in the backends (`WgslCodegen` in `@fdw/engine-webgpu`).

## Position in the stack

```
engine-shader    ← material graph, types, compiler (this package)
     ▲
engine-backend   ← abstract API: ShaderCodegen, PhysicalLayoutStrategy
     ▲
engine-webgpu    ← WebGPU backend: WgslCodegen, wgslLayoutStrategy
```

## Public API

### Types

| Export                                                                                | Kind            | Description                                                                                                                  |
| ------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ShaderType`                                                                          | type            | Logical shader type: scalar, vector, matrix, array, struct, texture, sampler                                                 |
| `BuiltinTypes`                                                                        | const           | Shortcuts: `BuiltinTypes.f32`, `BuiltinTypes.vec3f`, `BuiltinTypes.mat4f`, `BuiltinTypes.texture2d`, `BuiltinTypes.sampler`… |
| `scalar()`, `vec()`, `mat()`, `arrayType()`, `structType()`, `texture()`, `sampler()` | function        | Type constructors                                                                                                            |
| `PortType`, `generic()`, `elementOf()`, `vectorOf()`                                  | type / function | Port types, with generics and constraints (`numeric`, `float`, `float-vector`, `integer`)                                    |
| `ConstantValue`                                                                       | type            | Untyped literal (`number`, `boolean`, `number[]`), typed by the port it is attached to                                       |
| `typeEquals()`, `typeToString()`                                                      | function        | Comparison and readable representation                                                                                       |

### Graph

| Export                                                              | Kind            | Description                                                                                            |
| ------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `MaterialGraphData`, `GraphNode`, `GraphEdge`                       | type            | Serializable graph model                                                                               |
| `NodeDefinition`, `FunctionDefinition`, `PortSchema`, `ParamSchema` | type            | Node type description                                                                                  |
| `NodeRegistry`                                                      | class           | Registry of node types                                                                                 |
| `GraphBuilder`, `PortHandle`                                        | class           | Fluent API to build a graph, with types checked on each call                                           |
| `validateGraph()`                                                   | function        | Structural and type validation; returns diagnostics, topological order and port types                  |
| `resolveNodeTypes()`                                                | function        | Type inference of a node: generics unification, scalar splat, constraints                              |
| `serializeGraph()`, `parseGraph()`                                  | function        | JSON serialization                                                                                     |
| `defineFunction()`, `GraphFunctionData`                             | function / type | A node type defined by a function graph, inlined by the compiler; graphs embed the functions they call |
| `Diagnostic`, `GraphError`                                          | type / class    | Errors and warnings, located by node and port                                                          |

### Compiler

| Export                                                    | Kind     | Description                                                                      |
| --------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `compile()`                                               | function | Graph → `CompiledProgram`. Throws a `GraphError` when the graph has errors       |
| `CompiledProgram`                                         | type     | `programKey`, IR `module`, logical `layout`, `vertexInputs`, warnings            |
| `ShaderModuleIR`, `IrEntryPoint`, `IrInstruction`, `IrOp` | type     | Intermediate representation: typed SSA instructions, one straight list per stage |
| `ProgramLayout`, `LogicalBinding`                         | type     | Resources grouped by slot (`frame`, `material`, `object`, custom slots)          |
| `engineUniformBlocks`, `engineValueLocations`             | const    | Fixed contract of the `frame` and `object` slots, shared by every program        |

### Standard library

| Export                     | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std`                      | Functions: `add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `floor`, `fract`, `sqrt`, `sin`, `cos`, `saturate`, `pow`, `dot`, `length`, `normalize`, `cross`, `reflect`, `mix`, `clamp`, `smoothstep`, `step`, `select`, integers (`remainder`, `bitAnd`, `bitOr`, `bitXor`, `shiftLeft`, `shiftRight`, `uvec2`, `uvec3`, `uvec4`), arrays (`index`, `arrayLength`: storage buffers read with `g.storage(name, arrayType(element))`), comparisons (`less`, `lessEqual`, `greater`, `greaterEqual`, `equal`, `notEqual`, component-wise), `perFragment`, `textureSample`, `textureSampleLevel`, `textureSampleCompare` (depth comparison with a depth texture and a comparison sampler), `textureSampleCube`, `textureSampleCubeLevel` (cube textures, by direction), screen space derivatives `dpdx`, `dpdy`, `fwidth` (fragment stage only, `y` down on every backend), `vec2`, `vec3`, `vec4`, `extend`, `transform`, `transform3`, `convert` |
| `stdInputs`                | `input.attribute`, `input.uniform`, `input.storage`, `input.texture`, `input.sampler`, `input.builtin`, `input.engine`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `stdConstants`             | `const.value`, `const.pi`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `stdMacros`                | `staticSwitch`, `optionalAttribute`, `repeat`, `normalMapping`, `bumpMapping`, `parallaxMapping`, `parallaxOcclusionMapping`, `displacement` (and the `lighting.*` shading models and the `camera.positionFromDepth` function, registered by name)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stdLights`                | `light.current`, `light.sum`: the lights of the frame; `light.shadow`: the visibility of the light being summed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `stdLoops`                 | `loop.fold` (a fold loop over a function node) and its parts `loop.state`, `loop.index`, `loop.end`; `GraphBuilder.fold(initial, count, body)` builds one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `stdNoise`                 | `fbm`, `ridged`, `turbulence` (fractal sums, octaves unrolled or in a fold loop, faded below the pixel with `filtered`), `warp` (domain warping), `value`, `perlin`, `simplex`, `worley` (of points of 2 to 4 dimensions); by id, `noise.value2…4`, `noise.perlin2…4`, `noise.simplex2…4`, `noise.worley2…4`, the hashes `noise.pcg`, `noise.pcg2d…4d`, `noise.hash2…4`, `noise.random2…4`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stdPatterns`              | `pattern.checker`, `pattern.stripes`, their filtered versions (averaged over the pixel), `pattern.bricks`, `pattern.tiles`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stdMapping`               | `mapping.objectPosition`, `mapping.worldPosition`, `mapping.objectNormal`, `mapping.worldNormal` (per fragment), `mapping.triplanar` (a function of a uv on the three planes of the axes), `mapping.triplanarTexture`, `mapping.triplanarWeights`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `stdFunctionPorts`         | `function.input`, `function.output`: the ports of a function graph                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stdOutputs`               | `output.surface` (shading models `unlit`, `phong`, `pbr`), `output.fullscreen` (post-processing passes, with the `screen-uv` builtin), and the raw `output.vertex` / `output.fragment`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `createStandardRegistry()` | A `NodeRegistry` with all the standard node types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Usage

```ts
import { GraphBuilder, T, std } from '@fdw/engine-shader';

const g = new GraphBuilder('textured-phong');

const uv = g.attribute('uv', BuiltinTypes.vec2f);
const diffuse = g.texture('diffuseMap', { slot: 'material' });
const smp = g.sampler('diffuseSampler', { slot: 'material' });
const tint = g.uniform('tint', BuiltinTypes.vec4f, {
  slot: 'material',
  default: [1, 1, 1, 1],
});

const texel = g.call(std.textureSample, { texture: diffuse, sampler: smp, uv });
const color = g.call(std.mul, { a: texel, b: tint });

g.surface({
  shadingModel: 'phong',
  baseColor: color.swizzle('rgb'),
  alpha: color.swizzle('a'),
  shininess: g.constant(BuiltinTypes.f32, 32),
});

const graph = g.build(); // MaterialGraphData, serializable with serializeGraph()
```

Type errors are reported as soon as a node is added, with the faulty node and port:

```
error: #n3.b: std.mul: got vec4<f32>, incompatible with vec3<f32> connected to "a"
```

## Type rules

- **The only implicit conversion** is the scalar splat: an `f32` can be connected to a `vec3<f32>` input. Every other conversion needs an explicit node (`std.convert`, `std.vec3`, `std.extend`) or a swizzle.
- **Generics** are unified from the connected inputs: `mul(f32, vec3<f32>)` binds `T = vec3<f32>`. When no input of a generic is connected, the type of its literal default is used (`f32`, or a float vector).
- **Swizzles** are carried by the edges (`.xyz`, `.rg`), and cannot mix component sets (`.xg`).
- **Resources** (uniforms, storage buffers, textures, samplers) are identified by name: nodes using the same name must declare the same resource.

## Compilation

```ts
import { compile } from '@fdw/engine-shader';
import { WgslCodegen, wgslLayoutStrategy } from '@fdw/engine-webgpu';

const program = compile(graph, {
  vertexAttributes: ['position', 'normal', 'uv'],
});
const layout = wgslLayoutStrategy.resolve(program.layout); // bindings, offsets
const sources = new WgslCodegen().emit(program.module, layout);
```

The compiler runs these passes:

1. **Validation** of the graph, then of what the compiler supports.
2. **Lowering** of `output.surface`: standard vertex stage (object → world → clip space) and shading model, ending with `output.vertex` and `output.fragment`. `output.fullscreen` is lowered to a triangle covering the target, computed from `vertex-index`, and `screen-uv` to its interpolated coordinates (origin at the top left on every backend), read per fragment: what depends on them is computed per pixel.
3. **Optimizations**: dead code elimination (unused resources included), constant folding (f32 scalars and vectors), common subexpression elimination.
4. **Frequency analysis**: each value is constant, per draw (uniforms, textures, engine values), per vertex or per fragment. Per-vertex values used by the fragment stage are computed as early as possible and interpolated through varyings (flat for integers); constant and uniform values are recomputed in each stage; values that cannot be interpolated (bool, matrices) are computed in the fragment stage.
5. **Layout**: `frame` (group 0), `material` (group 1), `object` (group 2), then custom slots sorted by name. Within a slot: one uniform block, then textures and samplers, each sorted by name.
6. **IR generation** and **program key**: a Merkle hash of the optimized graph, independent of the node ids and of the uniform values.

## Macros and variants

A macro is a node evaluated at compile time: it is replaced by the nodes it generates. Macros read **static parameters** (`context.feature(name)`), which come from the material features (`compile(graph, { features })`), then from the parameters declared by the graph (`g.parameter(name, default)`), then from the mesh (`hasAttribute.<semantic>`). Every parameter read is recorded in the **variant key** of the program; parameters that are not read do not create variants.

| Macro                            | Description                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `macro.staticSwitch`             | `ifTrue` or `ifFalse` from a feature: only the chosen branch is compiled                                                                                                            |
| `macro.optionalAttribute`        | A vertex attribute when the mesh has it, a fallback otherwise                                                                                                                       |
| `macro.repeat`                   | Applies a function node `count` times, with the iteration index                                                                                                                     |
| `macro.normalMapping`            | World normal perturbed by a tangent-space normal map (OpenGL convention), in the frame of the tangents of the mesh, else of the screen space derivatives of the position and the uv |
| `macro.bumpMapping`              | World normal perturbed by the screen space slopes of a height (Mikkelsen 2010), without tangents nor uv                                                                             |
| `macro.parallaxMapping`          | The uv shifted along the view by a height map (one read)                                                                                                                            |
| `macro.parallaxOcclusionMapping` | The uv where the view meets the relief of a height map, `steps` reads unrolled at compilation                                                                                       |
| `macro.displacement`             | The offset of a vertex along its normal by a height map read in the vertex stage, for `positionOffset`                                                                              |

```ts
const g = new GraphBuilder('vertex-colored');
const color = g.call(
  stdMacros.optionalAttribute,
  { fallback: [1, 1, 1] },
  {
    params: { semantic: 'color', type: BuiltinTypes.vec3f },
  },
);
g.surface({ baseColor: color });
// A mesh with colors and a mesh without get two programs; a graph that does
// not read the colors gives the same program for both.
```

**Shading models are nodes** named `lighting.<model>`, inserted by the compiler behind `output.surface`: the inputs of the surface are those of its model. The standard ones are function graphs:

| Model   | Inputs (besides `baseColor`, `alpha`)                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlit` | —                                                                                                                                                     |
| `phong` | `emissive`, `normal`, `specular`, `shininess`                                                                                                         |
| `pbr`   | `emissive`, `normal`, `metallic`, `roughness`, `occlusion` — metallic/roughness as in glTF: Cook-Torrance with GGX, Smith-Schlick and Schlick Fresnel |

`normal` is optional: when unconnected, the model gets the interpolated normal of the mesh. A custom model is a function graph with the inputs of its surface plus `worldPosition` (vec4), and a `color` output (vec4), registered with `defineShadingModel(name, graph)`; it can also replace a standard one in a registry. It reads the lights with `light.current` / `light.sum`.

**Colors are linear.** The `toneMapping` feature (`none`, `reinhard`, `aces`, `neutral` — Khronos PBR Neutral) multiplies the color of the model by the `exposure` of the frame and tone maps it; the `outputEncoding` feature (`srgb`) encodes it for display. The `Renderer` sets both from its `output` option; without them, the color is written as is. The operators and the encoding are function graphs too (`color.toneMapAces`, `color.linearToSrgb`…).

`lighting.phong` sums the lights of the frame, without limit:

```
Σ (ambient × baseColor + (diffuse × baseColor × max(N·L, 0) + specular × specularColor × max(V·R, 0)^shininess) × attenuation × spot) + emissive
```

The normal and the position are interpolated, then the lighting is computed per fragment (`std.perFragment`).

**Lights** are read with two nodes of `stdLights`, usable in custom shading models too:

- `light.current`: the light being summed — `position` (w = 0 for a directional light), `ambient`, `diffuse`, `specular`, `attenuation`, `spotDirection`, `spotCone`, and its shadow map: `shadow`, `shadowRect`, `shadowMatrix` — read from the light pool, a storage buffer of the `frame` group (`lights`, `LightVec4s` vec4 per light, see `lightMembers`);
- `light.sum`: the sum of its `value` input over the lights. Given the world `position` of the point lit, and with the `lightClusters` feature (set by the renderer), over the global lights and those of the cluster of the point only (the `lightGrid` storage buffer, see `lightClusterMembers`); the body of such a loop cannot compute derivatives (`textureSample`, `dpdx`…): its count changes from pixel to pixel;
- `light.shadow`: the visibility of the light being summed at a `position` with a `normal` (1 lit, 0 in shadow). With the `shadows` feature, a macro reading the tile of the light in the shadow atlas (the `shadowMap` and `shadowSampler` engine values, 3 × 3 filtered comparisons); without it, 1. The phong and pbr models multiply their direct light by it.

**The environment** (image-based lighting): with the `environment` feature, the `environment.light` macro (`stdEnvironment.light`) gives the light of the environment a surface reflects, from a prefiltered atlas (the `environmentMap` and `environmentSampler` engine values, see `environmentMembers`): the irradiance of the normal × the diffuse color, the radiance of the reflected direction prefiltered for the roughness × (F0 × A + B) (the split sum). `pbr` and `phong` add it; without the feature, it is black and costs nothing. The function graphs `environment.radiance`, `environment.irradiance`, `environment.brdf`, `environment.octahedral` and `environment.equirect` (and their inverses) are usable in any graph.

The `depthOnly` feature compiles a surface without color (`output.fragment` without `color`): the position, and the discard of masked materials, for shadow maps and depth prepasses.

The nodes depending on `light.current` form the body of a loop over the lights; the others are computed once, before it. A per-light value can only reach the outputs through a `light.sum`. In the IR, the loop is a `loop-sum` instruction, the only control flow, whose body is itself straight code.

```ts
const light = g.node(stdLights.current);
const received = g.call(stdLights.sum, {
  value: g.call(std.mul, { a: light.diffuse, b: tint }),
});
```

## Functions

A function is written as a graph and used as a node. Its `function.input` nodes are the inputs of the node, its `function.output` nodes its outputs (typed by their value):

```ts
const f = new GraphBuilder('scale');
const value = f.functionInput('value', BuiltinTypes.vec3f);
const factor = f.functionInput('factor', BuiltinTypes.f32, { default: 2 });
f.functionOutput('result', f.call(std.mul, { a: value, b: factor }));
const scale = defineFunction(f.build(), { id: 'my.scale' });

g.surface({ baseColor: g.call(scale, { value: color }) });
```

The compiler **inlines** each call: the program is the same as with the graph written in place, and the optimizations, the stages and the light loops apply through the function. A function graph can use resources (uniforms, textures), macros, lights and other functions; recursive functions are rejected. `build()` embeds the called functions in the `functions` section of the graph, so that a JSON graph compiles without registering them.

## Loops

`macro.repeat` unrolls a function `count` times, `count` known at compilation. `g.fold(initial, count, body)` builds a **fold loop** instead: state = initial, then `count` times state = body(state, index), in a loop of the target language (`loop-fold` in the IR). The count can be a uniform; the nodes of the body that depend on neither the state nor the index are computed once, before the loop; loops nest. The body is found from its `loop.state` and `loop.index` nodes, tied to their `loop.end`: what depends on them, up to the end. The body runs in the stage of its end, at its frequency.

```ts
const sum = g.fold(0, g.uniform('count', BuiltinTypes.u32), (state, index) =>
  g.call(std.add, {
    a: state,
    b: g.call(
      std.convert,
      { value: index },
      { params: { to: BuiltinTypes.f32 } },
    ),
  }),
);
```

## Procedural materials

The noises (`stdNoise`), the patterns (`stdPatterns`) and the mapping (`stdMapping`) are function graphs and macros of the standard library, built on the integer operators: the hashes are PCG hashes on u32 (Jarzynski and Olano 2020), whose products wrap around on every backend, so that a noise gives the same bits in WGSL, GLSL ES and HLSL. The package `@fdw/engine-noise` computes the same noises in TypeScript; the rendering tests compare them. `bakeTexture` (`@fdw/engine-core`) renders an expensive graph once into a texture. See [design/p14-procedural.md](../../design/p14-procedural.md).

```ts
const height = g.call(
  stdNoise.fbm,
  { point: g.call(stdMapping.worldPosition).swizzle('xz') },
  { params: { noise: 'simplex', octaves: 6, filtered: true } },
);
```

## Compute graphs

A compute graph is a graph ending with `output.compute` (the size of its workgroups) instead of a surface; it writes storage buffers declared with read-write access, with `write.storage` nodes:

```ts
const g = new GraphBuilder('scale');
const index = g.builtin('global-invocation-id').swizzle('x');
const input = g.storage('input', arrayType(BuiltinTypes.f32));
const output = g.storage('output', arrayType(BuiltinTypes.f32), {
  access: 'read-write',
});
g.write(output, {
  index,
  value: g.call(std.mul, {
    a: g.call(std.index, { array: input, index }),
    b: g.uniform('factor', BuiltinTypes.f32),
  }),
  when: g.call(std.less, {
    a: index,
    b: g.call(std.arrayLength, { array: input }),
  }),
});
g.compute({ workgroupSize: [64, 1, 1] });
const program = compile(g.build());
```

It compiles to a single `compute` stage of the IR, whose writes are results made after its body. The compiler rejects the nodes of the other stages (`std.textureSample` needs the derivatives of the fragment stage: use `std.textureSampleLevel`), reading a buffer the graph writes (threads run in any order), and writing a read-only buffer. A compute graph only has the slots it uses. Not available on WebGL2 (capability `compute`).

### Current limitations

- At most 16 lights per frame; shadows for directional and spot lights only.
- No image-based lighting (IBL) yet: the ambient term of the lit models is a constant color per light.
- Without an HDR target (`rgba16float`), tone mapping is applied per material, before blending: slightly wrong for transparent materials.
- Storage buffers are read-only runtime-sized arrays of scalars, vectors and matrices (no structs), not available on WebGL2; no array or struct uniforms in materials (the engine uses arrays for the lights); no `f16`.
- Function inputs have concrete types (no generics yet: the generic noises and sums are macros); functions are inlined, not emitted as functions of the target language; no native functions.
- `textureSample` takes 2D textures, `textureSampleCube` cube textures; no array nor 3D textures in materials.
