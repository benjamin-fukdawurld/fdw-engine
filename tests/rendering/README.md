# Rendering tests

End-to-end tests of the engine: material graphs are compiled, rendered with the `Renderer` of `@fdw/engine-core` on the WebGPU backend, and the pixels of the frames are checked.

They run in Node with [Dawn](https://dawn.googlesource.com/dawn), the WebGPU implementation of Chrome, through the `webgpu` npm package, on a software adapter when no GPU is available. They are skipped on platforms where Dawn cannot load.

```sh
npx nx test rendering-tests
```

This project depends on all the engine packages: keeping these tests here avoids test-only dependencies between packages (a frontend package depending on a backend).
