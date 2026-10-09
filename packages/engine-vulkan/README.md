# @fdw/engine-vulkan

The Vulkan backend, in progress (phase 6 of the design, see [design/native-backends.md](../../design/native-backends.md), in French). For now: the HLSL generator, whose code DXC compiles to SPIR-V, and the tools of the Vulkan SDK used by the tests. The native addon (device, resources, pipelines, commands) comes next.

## Public API

| Export                                                             | Kind     | Description                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HlslCodegen`                                                      | class    | Implements `ShaderCodegen`: HLSL 2021 (Shader Model 6) from the IR of `@fdw/engine-shader`, with `vs_main`, `ps_main` and `cs_main` entry points, Vulkan bindings (`[[vk::binding]]`) and explicit uniform offsets (`[[vk::offset]]`) |
| `hlslType`                                                         | function | The HLSL name of a shader type (`float3`, `float4x4`, `Texture2D<float4>`…)                                                                                                                                                           |
| `dxcArguments`                                                     | function | The DXC arguments compiling a stage to SPIR-V for Vulkan 1.3                                                                                                                                                                          |
| `findTool`, `compileHlsl`, `validateSpirv`, `reflectUniformBlocks` | function | The command line tools of the Vulkan SDK (DXC, spirv-val, spirv-cross), found through `VULKAN_SDK` or the `PATH`: for tests and tooling                                                                                               |

The layout is `std140LayoutStrategy` of `@fdw/engine-backend`: std140 uniform blocks, std430 storage buffers, the groups as descriptor sets.

## Conventions

- Matrices are column-major (`#pragma pack_matrix(column_major)`): a product with a matrix is `mul(m, v)`, matrix constants are written by rows, as HLSL constructors take them.
- `select(condition, ifTrue, ifFalse)` of HLSL 2021; `frac` and `lerp` for `fract` and `mix`; `SampleCmpLevelZero` for the depth comparisons of the shadows.
- The number of workgroups has no HLSL system value: on Vulkan, its SPIR-V builtin is declared with `[[vk::ext_builtin_input(24)]]`.

## Tests

With the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home) (`source <sdk>/setup-env.sh`), the tests compile the generated code with DXC, validate it with spirv-val, and compare the offsets of the uniform blocks with spirv-cross. `tests/rendering` does the same for every program of the rendering suite. Without the SDK, these tests are skipped.
