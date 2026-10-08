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

| Export                     | Content                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std`                      | Functions: `add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `floor`, `fract`, `sqrt`, `sin`, `cos`, `saturate`, `pow`, `dot`, `length`, `normalize`, `cross`, `reflect`, `mix`, `clamp`, `smoothstep`, `step`, `select`, comparisons (`less`, `lessEqual`, `greater`, `greaterEqual`, `equal`, `notEqual`, component-wise), `perFragment`, `textureSample`, `vec2`, `vec3`, `vec4`, `extend`, `transform`, `transform3`, `convert` |
| `stdInputs`                | `input.attribute`, `input.uniform`, `input.storage`, `input.texture`, `input.sampler`, `input.builtin`, `input.engine`                                                                                                                                                                                                                                                                                                             |
| `stdConstants`             | `const.value`, `const.pi`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `stdMacros`                | `staticSwitch`, `optionalAttribute`, `repeat`, `normalMapping` (and the `lighting.*` shading models, registered by name)                                                                                                                                                                                                                                                                                                           |
| `stdLights`                | `light.current`, `light.sum`: the lights of the frame                                                                                                                                                                                                                                                                                                                                                                              |
| `stdFunctionPorts`         | `function.input`, `function.output`: the ports of a function graph                                                                                                                                                                                                                                                                                                                                                                 |
| `stdOutputs`               | `output.surface` (shading models `unlit`, `phong`, `pbr`), and the raw `output.vertex` / `output.fragment`                                                                                                                                                                                                                                                                                                                         |
| `createStandardRegistry()` | A `NodeRegistry` with all the standard node types                                                                                                                                                                                                                                                                                                                                                                                  |

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
2. **Lowering** of `output.surface`: standard vertex stage (object → world → clip space) and shading model, ending with `output.vertex` and `output.fragment`.
3. **Optimizations**: dead code elimination (unused resources included), constant folding (f32 scalars and vectors), common subexpression elimination.
4. **Frequency analysis**: each value is constant, per draw (uniforms, textures, engine values), per vertex or per fragment. Per-vertex values used by the fragment stage are computed as early as possible and interpolated through varyings (flat for integers); constant and uniform values are recomputed in each stage; values that cannot be interpolated (bool, matrices) are computed in the fragment stage.
5. **Layout**: `frame` (group 0), `material` (group 1), `object` (group 2), then custom slots sorted by name. Within a slot: one uniform block, then textures and samplers, each sorted by name.
6. **IR generation** and **program key**: a Merkle hash of the optimized graph, independent of the node ids and of the uniform values.

## Macros and variants

A macro is a node evaluated at compile time: it is replaced by the nodes it generates. Macros read **static parameters** (`context.feature(name)`), which come from the material features (`compile(graph, { features })`), then from the parameters declared by the graph (`g.parameter(name, default)`), then from the mesh (`hasAttribute.<semantic>`). Every parameter read is recorded in the **variant key** of the program; parameters that are not read do not create variants.

| Macro                     | Description                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `macro.staticSwitch`      | `ifTrue` or `ifFalse` from a feature: only the chosen branch is compiled                                           |
| `macro.optionalAttribute` | A vertex attribute when the mesh has it, a fallback otherwise                                                      |
| `macro.repeat`            | Applies a function node `count` times, with the iteration index                                                    |
| `macro.normalMapping`     | World normal perturbed by a tangent-space normal map when the mesh has tangents, the interpolated normal otherwise |

```ts
const g = new GraphBuilder('vertex-colored');
const color = g.call(
  stdMacros.optionalAttribute,
  { fallback: [1, 1, 1] },
  {
    params: { semantic: 'color', type: BuiltinTypes.vec3f },
  }
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

`lighting.phong` sums the lights of the frame (up to `MaxLights`, 16):

```
Σ (ambient × baseColor + (diffuse × baseColor × max(N·L, 0) + specular × specularColor × max(V·R, 0)^shininess) × attenuation × spot) + emissive
```

The normal and the position are interpolated, then the lighting is computed per fragment (`std.perFragment`).

**Lights** are read with two nodes of `stdLights`, usable in custom shading models too:

- `light.current`: the light being summed — `position` (w = 0 for a directional light), `ambient`, `diffuse`, `specular`, `attenuation`, `spotDirection`, `spotCone`;
- `light.sum`: the sum of its `value` input over the lights.

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

### Current limitations

- At most 16 lights per frame, without shadows.
- No image-based lighting (IBL) yet: the ambient term of the lit models is a constant color per light.
- Tone mapping is applied per material, before blending: slightly wrong for transparent materials until the render graph brings a post-processing pass.
- No storage buffers, no array or struct uniforms in materials (the engine uses arrays for the lights), no `f16`.
- Function inputs have concrete types (no generics yet); functions are inlined, not emitted as functions of the target language; no native functions.
- `textureSample` only takes 2D textures.
