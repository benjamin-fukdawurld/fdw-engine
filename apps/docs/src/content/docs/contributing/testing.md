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

| File                     | Backend                                         | Needs                                                          |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------- |
| `dawn.spec.ts`           | WebGPU on Dawn, in Node                         | the `webgpu` package (installed)                               |
| `webgl2.browser.spec.ts` | WebGL2, in headless Chromium                    | `npx playwright install chromium-headless-shell`               |
| `vulkan.spec.ts`         | Vulkan, with the validation layer               | the Vulkan SDK, and the addon built                            |
| `programs.spec.ts`       | Every program of the suite, in HLSL and GLSL ES | the Vulkan SDK (DXC, spirv-val, spirv-cross, glslangValidator) |

```sh
source <sdk>/setup-env.sh     # for the Vulkan, HLSL and GLSL tests
npx nx test rendering-tests
```

Without the SDK, the Vulkan, HLSL and GLSL tests are skipped, not failed —
unless they are required (see [Continuous integration](#continuous-integration)).
On Vulkan, a test fails if the validation layer reports anything.
`programs.spec.ts` records the programs compiled by the suite, then:

- compiles each of them in HLSL with DXC, validates the SPIR-V with
  `spirv-val`, and compares the uniform offsets of the layout with the
  reflection of `spirv-cross`;
- generates those WebGL2 can run (no compute stage, no storage buffer) in
  GLSL ES 3.00, and validates and links them with `glslangValidator`,
  stricter than the compilers of the browsers.

Pixel tests check **exact** values where the GPU computes them exactly
(clears, unlit colors), and ranges elsewhere (edges, filtering): the GPUs
round differently.

## The native packages

`engine-native` and `engine-vulkan` test their TypeScript side with mock
addons, and their native side on the real GPU when the addons are built.
The `test` targets depend on `build-native`, and their inputs include
`VULKAN_SDK`: Nx reruns them when the SDK changes.

## Benchmarks

`*.bench.ts` files measure the CPU cost of the renderer, the render graph,
the scene, the ECS, the geometry and the shader compiler, on the fake
backend: `npx vitest bench` in a package. Run them before and after a
change on a hot path:

```sh
npm run bench                                  # every package: bench.json
git stash && npm run bench -- base.json && git stash pop
npm run bench:compare -- base.json bench.json  # a table of the changes
```

On every pull request, the **Benchmarks** workflow does the same on the
CI: the change and its base measured in the same job, compared in the
summary of the run. A benchmark is marked slower or faster beyond 20 % and
beyond the margins of error of both measures. The runners are shared and
noisy: the workflow never fails, the table is a hint to look closer.

## Continuous integration

Every pull request runs on GitHub Actions (`.github/workflows/`), and must
be green to be merged into `main`:

| Check                     | What it runs                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Check`                   | The format, then typecheck, lint and tests of the projects affected by the change                    |
| `Native and rendering`    | The projects tagged `gpu`, when affected: the addons, Dawn and the rendering suite, on software GPUs |
| `Build the documentation` | The site, and its internal links and anchors                                                         |

The runners have no GPU: Vulkan runs on **lavapipe** (the software Vulkan
of Mesa), WebGL2 in Chromium on **SwiftShader**, the windows in a virtual
display (Xvfb). The projects that need a GPU, a SDK or a display carry the
tag `gpu` (`engine-webgpu`, `engine-native`, `engine-vulkan`,
`rendering-tests`).

On a workstation, a suite whose GPU, SDK, addon or display is missing is
skipped. In the CI, `FDW_REQUIRE_SUITES` lists the suites that must run
(`vulkan,dawn,hlsl,glsl,window`): a missing one fails instead of passing
silently. A new suite of this kind calls `canRun(name, ready, reason)` of
`@fdw/engine-backend/testing`.

To run the GPU suites as the CI does, on lavapipe:

```sh
source <sdk>/setup-env.sh
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json \
FDW_REQUIRE_SUITES=vulkan,dawn,hlsl,glsl,window \
npx nx run-many -t test -p tag:gpu
```

### The reference images of the examples

Each live example of the documentation is rendered in headless Chromium,
on WebGL2 and on WebGPU, both on SwiftShader, and its canvas compared to a
reference image (`apps/docs/tests/screenshots/`):

```sh
npx nx run docs:visual                         # builds the site, compares
npx nx run docs:visual -- --update-snapshots   # writes new references
```

The examples run with their clock stopped and stop after a few frames
(`?time=1.5&frames=10`): the image is the same at every run. An example
that needs compute shaders shows its message on WebGL2 instead.

When a change modifies what an example draws, update its references, look
at them, and commit them with the change. If the CI renders a little
differently from your machine, run the **Documentation** workflow by hand
with **update-screenshots**: it renders the references on the CI machine
and gives them as an artifact. When a comparison fails, the report with the
images of the difference is an artifact of the run.

## Before submitting

Work on a branch, and open a pull request: `main` only receives squashed
pull requests.

```sh
npm run format:check         # or npm run format, to fix it
npx nx affected -t typecheck lint test
npx nx run docs:build        # if the documentation changed
npm run docs:links           # then its links
```
