# @fdw/engine-occlusion

The occlusion culling of FdwEngine: the objects hidden behind the opaque objects of the previous frames are not drawn. See [design/p3-occlusion.md](../../design/p3-occlusion.md) (in French) and the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/occlusion-culling/).

```ts
import { OcclusionCulling } from '@fdw/engine-occlusion';

const occlusion = new OcclusionCulling();
// Each frame:
renderer.render({ source: scene, camera, surface, occlusion });
renderer.stats.get('scene')?.occluded; // the items left out
```

## How it works

After the opaque items of a view, full screen passes of the `Renderer`:

1. reduce the depth buffer to a pyramid of `r32float` levels, each texel the farthest depth of 2 × 2 texels of the level below (a Hi-Z), as distances along the axis of the camera;
2. test the box of each item the frustum kept, a texel each: its rectangle on the screen against the finest level where it spans 2 × 2 texels, its nearest point against the farthest depth there;
3. read the results back without waiting (`readTexture`), and leave out, one to three frames later, the items found hidden, until a test finds them visible again.

Only full screen passes reading texels (`std.textureLoad`, `std.textureLoadDepth`): the same on WebGPU, Vulkan and WebGL2, without compute shaders.

## Options

| Option       | Default | Role                                                                                   |
| ------------ | ------- | -------------------------------------------------------------------------------------- |
| `margin`     | 0.001   | How much farther, relatively, a box must be than the depth in front of it to be hidden |
| `motion`     | 2       | The boxes grow by the distance the camera moved since the previous frame, times this   |
| `maxPending` | 2       | Results awaited at most at once: no new test while they are                            |

## Limits

- One `OcclusionCulling` per view (camera).
- What becomes visible can appear a frame or two late (the results come back later); `motion` makes it rarer.
- Not with multisampling yet: the opaque items are drawn with `samples: 1`.
- The shadow casters are not culled by occlusion.
- A graph of the application gives the size of the frame (`new RenderGraph({ size })`).
