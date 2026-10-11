# @fdw/engine-input-web

The input source of a page for `@fdw/engine-input`: the keyboard, the pointer and the wheel of an element (a canvas, with a `tabindex` to receive the keys) or of the whole window, and the gamepads of the Gamepad API in the standard layout.

```ts
import { Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';

const input = new Input(new WebInputSource(canvas));
```

- Keys by `code` (their position), with their `key` for the labels.
- The pointer from 0 to 1 over the element (or the window), the wheel in notches (100 pixels, 3 lines or a page).
- The gamepads are polled with `navigator.getGamepads()` at each `update()`; those without the standard mapping are ignored. A gamepad shows once a button is pressed: a rule of the browsers.
