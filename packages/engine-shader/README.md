# @fdw/engine-shader

Material graph of FdwEngine: a backend-agnostic description of materials as a directed acyclic graph (DAG) of typed nodes.

This package is pure TypeScript, with no GPU dependency. It is the first step of the design described in [design/material-graph.md](../../design/material-graph.md): it provides the type system, the graph model, the standard node library, type inference, validation and serialization. The compiler (graph → IR) and the code generators come next.

## Position in the stack

```
engine-shader    ← material graph, types (this package)
     ▲
engine-core      ← frontend (scene, materials)
engine-backend   ← abstract API
engine-webgpu    ← WebGPU backend
```

## Public API

### Types

| Export | Kind | Description |
| --- | --- | --- |
| `ShaderType` | type | Logical shader type: scalar, vector, matrix, array, struct, texture, sampler |
| `T` | const | Shortcuts: `T.f32`, `T.vec3f`, `T.mat4f`, `T.texture2d`, `T.sampler`… |
| `scalar()`, `vec()`, `mat()`, `arrayType()`, `structType()`, `texture()`, `sampler()` | function | Type constructors |
| `PortType`, `generic()`, `elementOf()`, `vectorOf()` | type / function | Port types, with generics and constraints (`numeric`, `float`, `float-vector`, `integer`) |
| `ConstantValue` | type | Untyped literal (`number`, `boolean`, `number[]`), typed by the port it is attached to |
| `typeEquals()`, `typeToString()` | function | Comparison and readable representation |

### Graph

| Export | Kind | Description |
| --- | --- | --- |
| `MaterialGraphData`, `GraphNode`, `GraphEdge` | type | Serializable graph model |
| `NodeDefinition`, `FunctionDefinition`, `PortSchema`, `ParamSchema` | type | Node type description |
| `NodeRegistry` | class | Registry of node types |
| `GraphBuilder`, `PortHandle` | class | Fluent API to build a graph, with types checked on each call |
| `validateGraph()` | function | Structural and type validation; returns diagnostics, topological order and port types |
| `resolveNodeTypes()` | function | Type inference of a node: generics unification, scalar splat, constraints |
| `serializeGraph()`, `parseGraph()` | function | JSON serialization |
| `Diagnostic`, `GraphError` | type / class | Errors and warnings, located by node and port |

### Standard library

| Export | Content |
| --- | --- |
| `std` | Functions: `add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `floor`, `fract`, `sqrt`, `sin`, `cos`, `saturate`, `pow`, `dot`, `length`, `normalize`, `cross`, `reflect`, `mix`, `clamp`, `smoothstep`, `select`, `textureSample`, `vec2`, `vec3`, `vec4`, `extend`, `convert` |
| `stdInputs` | `input.attribute`, `input.uniform`, `input.storage`, `input.texture`, `input.sampler`, `input.builtin`, `input.engine` |
| `stdConstants` | `const.value`, `const.pi` |
| `stdOutputs` | `output.surface` (shading models `unlit`, `phong`, `pbr`) |
| `createStandardRegistry()` | A `NodeRegistry` with all the standard node types |

## Usage

```ts
import { GraphBuilder, T, std } from '@fdw/engine-shader';

const g = new GraphBuilder('textured-phong');

const uv = g.attribute('uv', T.vec2f);
const diffuse = g.texture('diffuseMap', { slot: 'material' });
const smp = g.sampler('diffuseSampler', { slot: 'material' });
const tint = g.uniform('tint', T.vec4f, { slot: 'material', default: [1, 1, 1, 1] });

const texel = g.call(std.textureSample, { texture: diffuse, sampler: smp, uv });
const color = g.call(std.mul, { a: texel, b: tint });

g.surface({
  shadingModel: 'phong',
  baseColor: color.swizzle('rgb'),
  alpha: color.swizzle('a'),
  shininess: g.constant(T.f32, 32),
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
