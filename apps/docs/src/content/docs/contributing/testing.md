---
title: Testing
description: Unit tests, the rendering suite shared by the backends, shader validation and benchmarks.
sidebar:
  order: 4
---

The tests use [Vitest](https://vitest.dev). `npx nx run-many -t test` runs
all of them; `npx nx test <project>` one project.

## Unit tests

Next to the code, as `src/**/*.spec.ts`. They need no GPU:

- **engine-shader**: graphs built, validated and compiled, checked on the
  IR (instructions, stages, layout) or on the diagnostics.
- **engine-core**: the renderer and the render graph on a **fake backend**
  (`src/testing/fakeBackend.ts`), which records the resources created and
  the commands encoded: what is drawn, in which order, with which buffers.
- **Code generators**: the generated code, on small programs.

## The rendering suite

`tests/rendering` renders the same scenes on every backend, through the
whole engine, into offscreen surfaces, and compares **pixels**. A feature
that changes what is drawn adds a test to `src/suite.ts`: it then runs on
all backends at once.

```ts
it('computes the functions of screen-uv per pixel', async () => {
  drawFullscreen(renderer, (g) => {
    /* … */
  });
  const pixel = await pixelsOf();
  expectColor(pixel(32, 32), [3, 0, 0, 255]);
});
```

| File                     | Backend                                  | Needs                                            |
| ------------------------ | ---------------------------------------- | ------------------------------------------------ |
| `dawn.spec.ts`           | WebGPU on Dawn, in Node                  | the `webgpu` package (installed)                 |
| `webgl2.browser.spec.ts` | WebGL2, in headless Chromium             | `npx playwright install chromium-headless-shell` |
| `vulkan.spec.ts`         | Vulkan, with the validation layer        | the Vulkan SDK, and the addon built              |
| `hlsl.spec.ts`           | Every program of the suite, through HLSL | the Vulkan SDK (DXC, spirv-val, spirv-cross)     |

```sh
source <sdk>/setup-env.sh     # for the Vulkan and HLSL tests
npx nx test rendering-tests
```

Without the SDK, the Vulkan and HLSL tests are skipped, not failed. On
Vulkan, a test fails if the validation layer reports anything.
`hlsl.spec.ts` records the programs compiled by the suite, compiles each of
them with DXC, validates the SPIR-V with `spirv-val`, and compares the
uniform offsets of the layout with the reflection of `spirv-cross`.

Pixel tests check **exact** values where the GPU computes them exactly
(clears, unlit colors), and ranges elsewhere (edges, filtering): the GPUs
round differently.

## The native packages

`engine-native` and `engine-vulkan` test their TypeScript side with mock
addons, and their native side on the real GPU when the addons are built.
The `test` targets depend on `build-native`, and their inputs include
`VULKAN_SDK`: Nx reruns them when the SDK changes.

## Benchmarks

`*.bench.ts` files measure the CPU cost of the renderer and the render
graph on the fake backend: `npx vitest bench` in `packages/engine-core`.
Run them before and after a change on a hot path.

## Before submitting

```sh
npx nx affected -t typecheck lint test
npx nx run docs:build        # if the documentation changed
```
