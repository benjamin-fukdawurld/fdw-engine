# @fdw/engine-skinning

The skinning of FdwEngine on the GPU: in a compute pass on WebGPU and Vulkan (the skinned vertices in a buffer, read by every pass: the camera, the shadows, the ray tracing to come), in the vertex stage on WebGL2. It skins the instances of the models of `@fdw/engine-assets` (glTF skins), posed by `@fdw/engine-animation`, and keeps their bounds around their joints. See [design/p6-animation.md](../../design/p6-animation.md) (in French) and the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/character-animation/).

```ts
import { clipsOf, Skinning } from '@fdw/engine-skinning';

const instance = instantiate(model, scene);
const skinning = new Skinning(backend, instance, model); // { mode: 'vertex' } forces the fallback
const animator = new Animator(graph, {
  skeleton: skinning.skeleton,
  clips: clipsOf(model),
});

// Each frame:
skinning.applyPose(animator.update(dt)).update();
renderer.render({
  source: scene,
  camera,
  surface,
  // compute mode: one compute pass for all the meshes, in the frame's graph
  prepare: (graph) => skinning.addPass(graph),
});
```

- **`addPass(graph)`**: the compute pass of the skinning in a render graph (all the primitives, one pass); **`dispatch()`**: the same outside of a graph, in one submission. Both do nothing in `vertex` mode.

- **`skinGraph(graph, mode, attributes)`**: the graph of a material, its position, normal and tangent skinned; **`skinningKernel`**: the compute graph.
- **`MeshSkin`**: the joints, weights and rest vertices of a mesh, read once; **`skinPositions`**: the same skinning on the CPU.
