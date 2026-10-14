# @fdw/engine-input

The input of FdwEngine: the keyboard, the pointer and the gamepads, read the same way in a page and in a native window, and named actions bound to them. Pure TypeScript, without dependency: the events come from a source, `WebInputSource` (`@fdw/engine-input-web`) or `NativeInputSource` (`@fdw/engine-input-native`). See [design/input.md](../../design/input.md) (in French) and the Input guide of the documentation.

```ts
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';

const input = new Input(new WebInputSource(canvas));
const actions = new ActionMap(input, {
  move: {
    type: 'vector',
    bindings: [
      { up: 'key:KeyW', down: 'key:KeyS', left: 'key:KeyA', right: 'key:KeyD' },
      'gamepad:leftStick',
    ],
  },
  jump: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
});

// Every frame, first:
input.update();
const { x, y } = actions.vector('move');
if (actions.button('jump').pressed) {
  // …
}
```

- **One state per frame**: `update()` applies the events received since the previous frame and polls the gamepads; `pressed` and `released` hold for that frame, and a press shorter than a frame is not lost.
- **Keys by position**: `KeyW` is the key at the place of W — Z on an AZERTY keyboard. `keyboard.label(code)` gives what it shows in the layout.
- **Gamepads in the standard layout** (Gamepad API, SDL3): `south`, `east`, `west`, `north`, shoulders, analog triggers, sticks with a radial dead zone.
- **Actions**: buttons, axes and vectors, several bindings each (the strongest wins), rebound at run time and saved as JSON.
- **Contexts**: an `ActionMap` per context (a menu, the game), `enabled` or not; a map enabled during a frame reads from the next one.
- **Pointer lock**: `input.lockPointer()`, relative movements in `pointer.dx` and `dy`, the `pointer:locked` control.
- **Rumble**: `gamepad.rumble(strong, weak, duration)`, or `actions.rumble()` for the gamepads of an `ActionMap`.
- **`FakeInputSource`**: a source driven by code, for tests and replays.
