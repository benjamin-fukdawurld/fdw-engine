# @fdw/demo-scenes

The scenes of the demos, independent of where they run: the routes of the web demo (`apps/demo`, in a canvas) and the native demo (`apps/demo-native`, in a native window). A scene is created from a `RenderBackend` and a `Surface`, and renders a frame at a time:

```ts
const scene = createShadowsScene(backend, surface);
scene.frame(time); // seconds since the start
scene.destroy();
```

It also holds the geometry the scenes share: `createSphere`, `createCube`, `axisAngle`.

The games: the maze, the first person shooter (`createFpsScene`), the
third-person game in the forest (`createTpsScene`, with a physics engine
and a resource store holding the models of `apps/docs/public/models/forest`,
made by `tools/assets`).
