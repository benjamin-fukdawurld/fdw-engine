# @fdw/engine-raytracing

Ray tracing on the backends with the `rayQuery` capability: in hardware on Vulkan (`VK_KHR_ray_query`), in software on WebGPU (a BVH built on the CPU, traversed in WGSL). WebGL2 keeps the rasterization.

- **The traced scene** (`RayScene`): the acceleration structures of a `RenderSource` or a list of items (a bottom level per mesh, the instances each frame) and the buffers of the hits; given to the `Renderer` (`rays`) and to the passes.
- **Shadows by rays**: `renderer.render({ …, rays: { scene, shadows: true } })` traces the shadows of the lights in the materials, instead of the shadow maps; soft with `samples` and the `softness` of the light.
- **Ambient occlusion** (`RayOcclusion`) and **reflections** (`RayReflections`): passes over a G-buffer (`reflectionOutputs`), the surfaces hit shaded with their own materials.
- **The path tracer** (`PathTracer`): the whole image by rays and bounces, in waves of compute passes; the frames gathered while nothing moves, an à-trous filter on the first ones. Its lights are packed in the format of the light pool of the renderer (`packLights`, `writeLightPool`); the rays lost see the gradient of its `sky`, or the panorama of an `Environment` (`trace({ environment })`, the reflections too).

See `design/p10-raytracing.md`.
