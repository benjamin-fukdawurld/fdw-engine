---
title: Input
description: The keyboard, the mouse and the gamepads, in a page and in a native window, read as named actions.
sidebar:
  order: 10
---

Three packages read the keyboard, the pointer and the gamepads, the same
way in a page and in a native window:

| Package                    | Contents                                                      |
| -------------------------- | ------------------------------------------------------------- |
| `@fdw/engine-input`        | The state of the devices (`Input`), the actions (`ActionMap`) |
| `@fdw/engine-input-web`    | `WebInputSource`: the DOM events, the Gamepad API             |
| `@fdw/engine-input-native` | `NativeInputSource`: a `NativeWindow`, the gamepads of SDL3   |

The core depends on neither the DOM nor SDL: an application chooses its
source, and the rest of its code is the same everywhere.

## A source, an input, a frame

```ts
import { Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';

const input = new Input(new WebInputSource(canvas));

function frame() {
  input.update(); // first, every frame
  if (input.keyboard.pressed('KeyF')) {
    toggleLight();
  }
  const { x, y } = input.gamepads[0]?.stick('left') ?? { x: 0, y: 0 };
}
```

- `WebInputSource(target)` listens to an element — a canvas: give it a
  `tabindex` so that it receives the keys once clicked — or to the whole
  `window`.
- `NativeInputSource(window)` listens to a `NativeWindow`. Its events are
  read by `runLoop`, as the other events of the window.

`update()` applies the events received since the previous frame, reads
the gamepads, then the state does not change until the next `update()`:
all the code of a frame sees the same input.

- `pressed` and `released` are true for the frame of the press or the
  release. A press shorter than a frame — down and up between two updates —
  is not lost: `pressed` is true, `isDown` false.
- The repeats of a key held down are not new presses.
- When the page or the window loses the focus, everything is released: a
  key released elsewhere does not stay down.
- With a [fixed step](/fdw-engine/game/the-game/#1-the-logic-at-a-fixed-step),
  a press is seen by every step of its frame: act on it once per frame,
  outside of the steps.

## The keyboard: positions, not letters

Keys are named by their **position** on the keyboard, as the `code` of the
DOM: `KeyW`, `ArrowUp`, `ShiftLeft`, `Space`, `Digit1`. On an AZERTY
keyboard, the key `KeyW` is Z: a game bound to `KeyW`, `KeyA`, `KeyS`,
`KeyD` is played with ZQSD there, without configuration. In a native
window, SDL gives the same positions (its scancodes), named the same way.

To show a key to the user, `input.keyboard.label('KeyW')` gives what it
produces in the layout of the keyboard (`Z`), once it was pressed — its
code before.

## The pointer

`input.pointer` gives `x` and `y` from 0 to 1 over the surface, from the
top left corner, `moved` during the frame, the buttons (`isDown(0)`: 0 is
the main button, 1 the middle, 2 the secondary), `dx` and `dy`: how far it
moved during the frame, in fractions of the surface (0 before its first
move), and `wheel`: the notches turned during the frame, positive
downwards.

## Gamepads

`input.gamepads` lists the gamepads connected, in the **standard layout**
of the Gamepad API and of SDL3 — the same buttons at the same places on
every gamepad:

| Buttons                                               | Axes                                 |
| ----------------------------------------------------- | ------------------------------------ |
| `south`, `east`, `west`, `north` (A, B, X, Y on Xbox) | `leftX`, `leftY`, `rightX`, `rightY` |
| `leftShoulder`, `rightShoulder`                       | from -1 to 1, y positive downwards   |
| `leftTrigger`, `rightTrigger`, analog                 |                                      |
| `back`, `start`, `guide`, `leftStick`, `rightStick`   |                                      |
| `dpadUp`, `dpadDown`, `dpadLeft`, `dpadRight`         |                                      |

- `value(button)` goes from 0 to 1 (analog for the triggers); a button is
  down beyond 0.5.
- `stick('left')` gives `{ x, y }` through a **radial dead zone**
  (`deadZone`, 0.15 by default): a stick at rest is never exactly at 0. The
  zone is on the length of the vector, so that the diagonals keep their
  direction, and the value is rescaled beyond it, so that it does not jump.
- In a browser, a gamepad shows once a button is pressed (a rule of the
  browsers, against fingerprinting); only those of the standard layout are
  read.

`input.lastDevice` is the device used last — `'keyboard'`, `'pointer'` or
`'gamepad'`: to aim with the mouse or a stick, or to show the right
buttons.

## Actions

An application should not read `KeyW` or `leftX` here and there. It
declares **actions**, and their bindings:

```ts
import { ActionMap } from '@fdw/engine-input';

const actions = new ActionMap(input, {
  move: {
    type: 'vector',
    bindings: [
      { up: 'key:KeyW', down: 'key:KeyS', left: 'key:KeyA', right: 'key:KeyD' },
      'gamepad:leftStick',
    ],
  },
  jump: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
  zoom: {
    type: 'axis',
    bindings: [{ negative: 'gamepad:dpadUp', positive: 'gamepad:dpadDown' }],
  },
});

const { x, y } = actions.vector('move'); // y forward
if (actions.button('jump').pressed) {
  jump();
}
```

| Type     | Read                                                       | Bindings                                                                     |
| -------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `button` | `button(name)`: `down`, `pressed`, `released`, `value`     | Keys, pointer buttons, gamepad buttons                                       |
| `axis`   | `axis(name)`: a number                                     | A stick axis, `pointer:wheel`, `pointer:deltaX`, or `{ negative, positive }` |
| `vector` | `vector(name)`: `{ x, y }`, length 0 to 1, y up or forward | `{ up, down, left, right }`, a stick, or `pointer:delta`                     |

The controls are strings — they save and compare as they are:

| Control                           | Meaning                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `key:<code>`                      | A key, by position: `key:KeyW`, `key:ArrowUp`             |
| `pointer:<button>`                | A pointer button: `pointer:0`                             |
| `pointer:wheel`                   | The wheel, an axis: the notches of the frame              |
| `pointer:delta`                   | The movement of the pointer during the frame, a vector    |
| `pointer:deltaX`, `deltaY`        | The same, as axes (y positive downwards)                  |
| `gamepad:<button>`                | A gamepad button: `gamepad:south`, `gamepad:rightTrigger` |
| `gamepad:<axis>`                  | A stick axis, through its dead zone: `gamepad:leftX`      |
| `gamepad:leftStick`, `rightStick` | A stick, for a vector (as a button: the stick pressed)    |

- **Several bindings** per action: the strongest wins — the keyboard and a
  stick do not add up. A button is down when any of its controls is.
- **Four keys** of a vector are normalized: the diagonal is not faster.
- **A vector goes up**: y is positive forward, while the raw axis of a
  stick is positive downwards. The binding of a stick turns it.
- **Every gamepad** drives the actions by default. For a game with a
  gamepad per player, `new ActionMap(input, definitions, { gamepad: 1 })`
  reads only the second one.

### Changing and saving the bindings

```ts
actions.rebind('jump', ['key:KeyJ', 'gamepad:east']);
localStorage.setItem('bindings', JSON.stringify(actions));

// Later: the saved bindings replace those of the definitions.
const saved = JSON.parse(localStorage.getItem('bindings') ?? '{}');
const restored = new ActionMap(input, definitions, { bindings: saved });
```

## Tests and replays

`FakeInputSource` is a source driven by code: `keyDown(code)`,
`keyUp(code)`, `connectGamepad()`, `setButton()`, `setAxis()`, and `sink`
for the pointer. It tests the logic of an application without a browser
nor a window, and replays recorded inputs.

```ts
const source = new FakeInputSource();
const input = new Input(source);
source.keyDown('KeyW');
input.update();
expect(actions.vector('move')).toEqual({ x: 0, y: 1 });
```

## A source of your own

An `InputSource` writes the events into the `InputSink` that `Input` gives
to its `attach()`, and fills the states of the gamepads in
`readGamepads(out)`, reusing the objects of `out`: nothing is allocated per
frame. A touch screen, a network replay or another windowing library is
one more source.

## Camera navigation

`@fdw/engine-camera` moves a camera with actions: `OrbitOperator` turns
around a point, `FlyOperator` flies or walks, with default bindings for
the keyboard, the mouse and the gamepads. See the
[Camera navigation tutorial](/fdw-engine/tutorials/camera-operators/).

## Not yet

Vibrations, pointer lock (relative movements, for a first person view), and
contexts of actions (a menu, a game) are not there yet; the API leaves
room for them.
