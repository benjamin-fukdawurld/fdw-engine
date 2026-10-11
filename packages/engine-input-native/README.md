# @fdw/engine-input-native

The input source of a native window for `@fdw/engine-input`: the keyboard, the pointer and the wheel of a `NativeWindow` (`@fdw/engine-native`, SDL3), and the gamepads of SDL3 in the standard layout of the Gamepad API.

```ts
import { Input } from '@fdw/engine-input';
import { NativeInputSource } from '@fdw/engine-input-native';
import { NativeWindow, runLoop } from '@fdw/engine-native';

const window = new NativeWindow({ title: 'Game' });
const input = new Input(new NativeInputSource(window));
runLoop(() => {
  input.update();
  // …
});
```

- Keys by `code`: the scancodes of SDL, named as the `code` of the DOM (`KeyW`, `ArrowUp`), the same as in a page.
- The events are read by `NativeWindow.pollEvents()`, which `runLoop` calls; a gamepad connected is opened then, and shows at the next frame.
- Losing the keyboard focus releases every key.
