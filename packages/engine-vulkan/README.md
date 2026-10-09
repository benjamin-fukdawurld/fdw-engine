# @fdw/engine-vulkan

The Vulkan backend (Node only): the abstract rendering API of `@fdw/engine-backend` on Vulkan 1.3, through a native library. The shared rendering suite passes on it with the validation layer. See [design/native-backends.md](../../design/native-backends.md) (in French), phase 6.

## Position in the stack

```
engine-core ──► engine-backend ◄── engine-vulkan (TS) ──► fdw_vulkan.node (C, Node-API)
                                                             └─► fdw_vulkan (C++20, C API) ──► Vulkan (volk, VMA), DXC
```

## Building the addon

It needs the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home), for the Vulkan headers, volk, VMA and DXC:

```sh
source <sdk>/setup-env.sh                  # sets VULKAN_SDK
npx nx run engine-vulkan:build-native      # or: node packages/engine-vulkan/scripts/build.mjs [--debug]
```

Without `VULKAN_SDK`, the addon is not built and the tests that need it are skipped. At run time, Vulkan is loaded by volk, and the DXC library (`libdxcompiler`) from `FDW_DXC_LIBRARY`, the SDK or the system. `FDW_VULKAN_ADDON` loads an addon from another path.

## Usage

```ts
import { VulkanEngine, VulkanOffscreenSurface } from '@fdw/engine-vulkan';

const engine = new VulkanEngine({ validation: true });
await engine.init();
const surface = new VulkanOffscreenSurface(1280, 720);
await surface.init(engine);
renderer = new Renderer(engine.backend!);
renderer.render({ items, camera, surface });
const pixels = await surface.readPixels();
// The validation messages since the last call.
console.log(engine.device!.takeMessages());
```

## Public API

| Export                                                             | Kind            | Description                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VulkanEngine`                                                     | class           | Implements `Engine`: a `VulkanDevice` and its `VulkanRenderBackend`. Options: `validation` (the Khronos layer, when installed), `application`                                                                                              |
| `VulkanDevice`                                                     | class           | The context of the native library (instance, GPU, queue, memory): `name`, `validation`, `takeMessages()`, `waitIdle()`, the buffer factory                                                                                                 |
| `VulkanRenderBackend`                                              | class           | Implements `RenderBackend`: buffers, textures, samplers, pipelines, command encoding and submission. `depth24plus` is a 32-bit float depth; `rgba16float` is renderable                                                                    |
| `VulkanSwapchain`                                                  | class           | The images presented into a native window (`NativeWindowHandle`): `acquire(width, height)`, `present()`; FIFO with `vsync`, else mailbox or immediate; at most two frames in flight. `VulkanWindowSurface` of `@fdw/engine-native` uses it |
| `VulkanOffscreenSurface`                                           | class           | A surface rendering into a texture, with `readPixels()`                                                                                                                                                                                    |
| `VulkanPipelineFactory`                                            | class           | Generates the HLSL of the programs, compiled to SPIR-V by the native side; std140 layouts (`std140LayoutStrategy`), groups as descriptor sets                                                                                              |
| `HlslCodegen`, `hlslType`, `dxcArguments`                          | class, function | The HLSL generator (Shader Model 6, HLSL 2021), and the DXC arguments of a stage                                                                                                                                                           |
| `findTool`, `compileHlsl`, `validateSpirv`, `reflectUniformBlocks` | function        | The command line tools of the Vulkan SDK (DXC, spirv-val, spirv-cross), for tests and tooling                                                                                                                                              |

## How it works

- **Commands**: the encoders write the commands of a frame as 32-bit words; `submit` replays them into a command buffer in a single native call.
- **Synchronization**: as in WebGPU, the library tracks how each texture and buffer was last used, and inserts the barriers: before a render pass for its attachments, groups and vertex and index buffers (its commands are walked ahead); before each dispatch for its groups.
- **Writes and reads**: `buffer.write` and texture uploads follow `queue.writeBuffer`: copied at once, applied in the order of the queue before the next commands. Reads wait for everything submitted before.
- **Conventions**: the viewport has a negative height, so that y points up in clip space as in WebGPU; matrices are column-major; images are stored from the top row.

## HLSL conventions

- Matrices are column-major (`#pragma pack_matrix(column_major)`): a product with a matrix is `mul(m, v)`, matrix constants are written by rows, as HLSL constructors take them.
- `select(condition, ifTrue, ifFalse)` of HLSL 2021; `frac` and `lerp` for `fract` and `mix`; `SampleCmpLevelZero` for the depth comparisons of the shadows.
- The number of workgroups has no HLSL system value: on Vulkan, its SPIR-V builtin is declared with `[[vk::ext_builtin_input(24)]]`.

## Tests

With the Vulkan SDK set up (`source <sdk>/setup-env.sh`): the generated code is compiled with DXC, validated with spirv-val and its uniform offsets compared with spirv-cross; the device, buffers, textures, passes and copies are tested on the GPU with the validation layer; `tests/rendering` runs the shared rendering suite on Vulkan, and checks every program of the suite through HLSL.
