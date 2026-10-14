# @fdw/engine-camera

Camera operators for FdwEngine: they move a camera from the actions of `@fdw/engine-input`, so the keyboard, the mouse and the gamepads drive it, and every control can be rebound. Pure TypeScript; the target is anything with a position and a rotation (a `Camera` of engine-core, the transform of a node). See [design/p4-camera-operators.md](../../design/p4-camera-operators.md) (in French) and the Camera navigation tutorial of the documentation.

```ts
import { FlyActions, FlyOperator } from '@fdw/engine-camera';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';

const input = new Input(new WebInputSource(canvas));
const fly = new FlyOperator(camera, new ActionMap(input, FlyActions), {
  position: { x: 0, y: 2, z: 8 },
});

// Every frame:
input.update();
fly.update(dt);
```

- **`FlyOperator`**: free flight, or walking (`mode: 'walk'`). The left stick and WASD move, the right stick, the arrows and the pointer dragged look around, the triggers and Q/E go down and up, Shift or the left stick pressed runs.
- **`OrbitOperator`**: around a pivot. The right stick, the arrows and the pointer dragged turn, the left stick and WASD move the pivot over the ground, the secondary button dragged pans, the wheel, the triggers and Q/E zoom.
- **Remappable**: `FlyActions` and `OrbitActions` are the default definitions of an `ActionMap`: `rebind()`, `toJSON()`, the `bindings` option. `names` maps the intents of an operator to the actions of an application.
- **Frame rate independent**: the sticks and the keys are rates, multiplied by `dt`; the pointer is a displacement (`pointer:delta`).
