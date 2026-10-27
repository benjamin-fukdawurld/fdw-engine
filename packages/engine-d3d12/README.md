# @fdw/engine-d3d12

The Direct3D 12 backend (Node on Windows only): the abstract rendering API of `@fdw/engine-backend` on Direct3D 12, through a native library. The shared rendering suite passes on it with the debug layer. See [design/native-backends.md](../../design/native-backends.md) (in French), phase 6, N5.

## Position in the stack

```
engine-core ──► engine-backend ◄── engine-d3d12 (TS) ──► fdw_d3d12.node (C, Node-API)
                                        │                    └─► fdw_d3d12 (C++20, C API) ──► Direct3D 12, DXGI, DXC
                                        └─► engine-vulkan (TS): buffers, textures, encoder, pipeline factory, HLSL
```

The native library has the API of the Vulkan one (`include/fdw/d3d12.h`, the `fdw_dx_` prefix): the same objects, ids and command words. The TypeScript objects of `@fdw/engine-vulkan` (buffers, textures, command encoder, object table, pass timer, acceleration structures, `VulkanPipelineFactory` with `target: 'd3d12'`) serve as they are; this package adds the device, the engine, the backend, the swapchain and the offscreen surface.

## Building the addon

On Windows, with Visual Studio (C++) and the Windows SDK (Direct3D 12, DXGI, `dxcapi.h`):

```sh
npx nx run engine-d3d12:build-native      # or: node packages/engine-d3d12/scripts/build.mjs [--debug]
```

Elsewhere, the addon is not built and the tests that need it are skipped. At run time, DXC is loaded with its validator, which signs the DXIL: `dxcompiler.dll` and `dxil.dll` from `FDW_DXC_LIBRARY` (the path of `dxcompiler.dll`), the newest Windows SDK, the Vulkan SDK or the system. `FDW_D3D12_ADDON` loads an addon from another path. The debug layer needs the Graphics Tools of Windows (an optional feature).

## Usage

```ts
import { D3D12Engine, D3D12OffscreenSurface } from '@fdw/engine-d3d12';

const engine = new D3D12Engine({ validation: true });
await engine.init();
const surface = new D3D12OffscreenSurface(1280, 720);
await surface.init(engine);
renderer = new Renderer(engine.backend!);
renderer.render({ items, camera, surface });
const pixels = await surface.readPixels();
// The messages of the debug layer since the last call.
console.log(engine.device!.takeMessages());
```

In a window: `D3D12WindowSurface` of `@fdw/engine-native`; the native demo runs on it with `nx run demo-native:start -- shadows --d3d12 [--validation]`.

## Public API

| Export                  | Kind  | Description                                                                                                                                                                                                                                                                     |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D3D12Engine`           | class | Implements `Engine`: a `D3D12Device` and its `D3D12RenderBackend`. Options: `validation` (the debug layer, when installed), `application`, `maxAnisotropy`                                                                                                                      |
| `D3D12Device`           | class | The context of the native library (the high performance GPU, its direct queue, descriptor heaps): `name`, `validation`, `takeMessages()`, `waitIdle()`, the buffer factory                                                                                                      |
| `D3D12RenderBackend`    | class | Implements `RenderBackend`. `depth24plus` is a 32-bit float depth; `rgba16float` is renderable; `compressedFormats`: the BC formats (Direct3D has neither ETC2 nor ASTC); `rayQuery` and `rayTracingPipeline` where the GPU has DXR 1.1 (`createBottomLevel`, `createTopLevel`) |
| `D3D12Swapchain`        | class | The images presented into a Win32 window (`NativeWindowHandle`), a DXGI flip model swapchain: `acquire(width, height)`, `present()`; at most two frames in flight                                                                                                               |
| `D3D12OffscreenSurface` | class | A surface rendering into a texture, with `readPixels()`                                                                                                                                                                                                                         |
| `loadD3D12Addon`        | fn    | The addon (`D3D12Addon`, the type of the Vulkan addon), and `addonPath()`                                                                                                                                                                                                       |

## How it works

- **Commands**: the encoders write the commands of a frame as 32-bit words; `submit` replays them into a command list in a single native call.
- **Synchronization**: as on Vulkan, the library tracks the state of each texture, and of each buffer in the command list being recorded (buffers decay to the common state between executions), and inserts the transition barriers before each pass, dispatch or copy, those of a pass together; UAV barriers between two uses of a storage buffer written by a dispatch. Each command list is executed alone, after the transfers (writes, uploads, read backs).
- **Resources**: committed resources; writes through chunks of upload memory reused once the GPU is done; the groups are descriptor tables in shader visible heaps (the samplers in tables shared by the groups with the same samplers), each group at its index as a register space.
- **HLSL for Direct3D 12** (`HlslCodegen` with `target: 'd3d12'`): registers (`b`, `t`, `s`, `u`) with the group as the space; uniform blocks as `cbuffer`s whose members keep the std140 offsets with `packoffset`; structured buffers padded to the std430 layout (a mat3 of an object row as a `float4x3` read through a cast). `SV_InstanceID` starts at 0 whatever the first instance, and HLSL has no system value for the number of workgroups: both come from root constants (`b0` of space 100), set for each draw and dispatch, and by the indirect dispatches through a command signature.
- **Rays** (DXR 1.1: raytracing tier 1.1 and Shader Model 6.5): the bottom levels built with the transfers at their creation, the top levels by `buildTopLevel` (the instances of `D3D12_RAYTRACING_INSTANCE_DESC`, both faces, opaque unless their material is masked), the dynamic bottom levels refit (`PERFORM_UPDATE`). The structures stay in the acceleration structure state, out of the tracking: UAV barriers before and after each build. A top level is bound as a view of its address (`t` register of its group). The programs tracing rays use `RayQuery` (Shader Model 6.5); with `rayTracing: true`, a compute program becomes a state object (a `lib_6_5` library: `rg_main`, `ms_main`, the hit group of `ch_main` and `ah_main`, the global root signature of the compute pipelines) dispatched by `DispatchRays`, a ray per thread, its shader table of three records in a buffer.
- **Levels of detail**: Direct3D 12 has no blit: each level of each layer is drawn from the previous one with a linear filter.
- **Conventions**: those of WebGPU are those of Direct3D (y up in clip space, down in the viewport, depth in [0, 1], images stored from the top row); matrices are column-major.

## Tests

On Windows, with the addon built: the device, buffers, textures, passes and copies on the GPU with the debug layer; `tests/rendering` runs the shared rendering suite on Direct3D 12, and the rays (`describeRays`) where the GPU has DXR 1.1; `engine-native` presents into a hidden window. The DXIL of the generated HLSL is checked in `@fdw/engine-vulkan` (offsets of the cbuffers in the disassembly of DXC).
