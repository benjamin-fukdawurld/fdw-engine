# @fdw/engine-core

High-level 3D engine API — the public-facing layer that users interact with.

Uses `@fdw/engine-backend` for GPU operations and `@fdw/cad-scene` for scene data.

## Public API

| Export            | Kind      | Description                                                 |
| ----------------- | --------- | ----------------------------------------------------------- |
| `Viewer`          | class     | Main entry point — owns the render loop, camera, and scene  |
| `ViewerOptions`   | interface | Configuration passed to `Viewer` constructor                |
| `Camera`          | class     | Perspective/orthographic camera with position, target, up   |
| `ProjectionMode`  | enum      | `Perspective` or `Orthographic`                             |
| `OrbitController` | class     | Mouse-driven orbit, pan, and zoom controller                |
| `SceneRenderer`   | class     | Renders a `CadScene` with per-body transforms and materials |

## Usage

```ts
import { WebGpuBackend } from '@fdw/engine-webgpu';
import { Viewer } from '@fdw/engine-core';
import { CadScene } from '@fdw/cad-scene';

const backend = new WebGpuBackend();
const viewer = new Viewer(canvas, backend);
await viewer.start();

const scene = new CadScene();
// … populate scene …
viewer.setScene(scene);
viewer.fitAll();
```

## Position in the stack

```
engine-backend
  └── engine-webgpu
        └── engine-core  ← this package
              ↑ uses cad-scene for scene data
```
