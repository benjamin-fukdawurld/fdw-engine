---
title: Entrées
description: Le clavier, la souris et les manettes, dans une page et dans une fenêtre native, lus sous forme d'actions nommées.
sidebar:
  order: 10
---

Trois packages lisent le clavier, le pointeur et les manettes, de la même
façon dans une page et dans une fenêtre native :

| Package                    | Contenu                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `@fdw/engine-input`        | L'état des périphériques (`Input`), les actions (`ActionMap`)  |
| `@fdw/engine-input-web`    | `WebInputSource` : les événements DOM, la Gamepad API          |
| `@fdw/engine-input-native` | `NativeInputSource` : une `NativeWindow`, les manettes de SDL3 |

Le cœur ne dépend ni du DOM ni de SDL : une application choisit sa source,
et le reste de son code est le même partout.

## Une source, une entrée, une frame

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

- `WebInputSource(target)` écoute un élément — un canvas : donnez-lui un
  `tabindex` pour qu'il reçoive les touches une fois cliqué — ou toute la
  `window`.
- `NativeInputSource(window)` écoute une `NativeWindow`. Ses événements sont
  lus par `runLoop`, comme les autres événements de la fenêtre.

`update()` applique les événements reçus depuis la frame précédente, lit
les manettes, puis l'état ne change plus jusqu'au `update()` suivant : tout
le code d'une frame voit les mêmes entrées.

- `pressed` et `released` sont vrais pendant la frame de l'appui ou du
  relâchement. Un appui plus court qu'une frame — enfoncé et relâché entre
  deux mises à jour — n'est pas perdu : `pressed` est vrai, `isDown` faux.
- Les répétitions d'une touche maintenue ne sont pas de nouveaux appuis.
- Lorsque la page ou la fenêtre perd le focus, tout est relâché : une
  touche relâchée ailleurs ne reste pas enfoncée.
- Avec un [pas fixe](/fdw-engine/fr/game/the-game/#1-la-logique-à-pas-fixe),
  un appui est vu par chaque pas de sa frame : réagissez-y une fois par
  frame, en dehors des pas.

## Le clavier : des positions, pas des lettres

Les touches sont nommées par leur **position** sur le clavier, comme le
`code` du DOM : `KeyW`, `ArrowUp`, `ShiftLeft`, `Space`, `Digit1`. Sur un
clavier AZERTY, la touche `KeyW` est Z : un jeu lié à `KeyW`, `KeyA`,
`KeyS`, `KeyD` s'y joue avec ZQSD, sans configuration. Dans une fenêtre
native, SDL donne les mêmes positions (ses scancodes), nommées de la même
façon.

Pour montrer une touche à l'utilisateur, `input.keyboard.label('KeyW')`
donne ce qu'elle produit dans la disposition du clavier (`Z`), une fois
qu'elle a été appuyée — son code avant cela.

## Le pointeur

`input.pointer` donne `x` et `y` de 0 à 1 sur la surface, depuis le coin
supérieur gauche, `moved` pendant la frame, les boutons (`isDown(0)` : 0 est
le bouton principal, 1 celui du milieu, 2 le secondaire), et `wheel` : les
crans tournés pendant la frame, positifs vers le bas.

## Les manettes

`input.gamepads` liste les manettes connectées, dans la **disposition
standard** de la Gamepad API et de SDL3 — les mêmes boutons aux mêmes
endroits sur toutes les manettes :

| Boutons                                                | Axes                                 |
| ------------------------------------------------------ | ------------------------------------ |
| `south`, `east`, `west`, `north` (A, B, X, Y sur Xbox) | `leftX`, `leftY`, `rightX`, `rightY` |
| `leftShoulder`, `rightShoulder`                        | de -1 à 1, y positif vers le bas     |
| `leftTrigger`, `rightTrigger`, analogiques             |                                      |
| `back`, `start`, `guide`, `leftStick`, `rightStick`    |                                      |
| `dpadUp`, `dpadDown`, `dpadLeft`, `dpadRight`          |                                      |

- `value(button)` va de 0 à 1 (analogique pour les gâchettes) ; un bouton
  est enfoncé au-delà de 0.5.
- `stick('left')` donne `{ x, y }` à travers une **zone morte radiale**
  (`deadZone`, 0.15 par défaut) : un stick au repos n'est jamais exactement
  à 0. La zone porte sur la longueur du vecteur, de sorte que les diagonales
  gardent leur direction, et la valeur est remise à l'échelle au-delà, de
  sorte qu'elle ne saute pas.
- Dans un navigateur, une manette n'apparaît qu'une fois un bouton appuyé
  (une règle des navigateurs, contre le fingerprinting) ; seules celles de
  la disposition standard sont lues.

`input.lastDevice` est le périphérique utilisé en dernier — `'keyboard'`,
`'pointer'` ou `'gamepad'` : pour viser avec la souris ou un stick, ou pour
afficher les bons boutons.

## Les actions

Une application ne devrait pas lire `KeyW` ou `leftX` çà et là. Elle
déclare des **actions**, et leurs liaisons :

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

| Type     | Lecture                                                                   | Liaisons                                                           |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `button` | `button(name)` : `down`, `pressed`, `released`, `value`                   | Touches, boutons du pointeur, boutons de manette                   |
| `axis`   | `axis(name)` : un nombre                                                  | Un axe de stick, `pointer:wheel`, ou `{ negative, positive }`      |
| `vector` | `vector(name)` : `{ x, y }`, longueur de 0 à 1, y vers le haut ou l'avant | `{ up, down, left, right }`, ou `gamepad:leftStick` / `rightStick` |

Les contrôles sont des chaînes — ils s'enregistrent et se comparent tels
quels :

| Contrôle                          | Signification                                                  |
| --------------------------------- | -------------------------------------------------------------- |
| `key:<code>`                      | Une touche, par position : `key:KeyW`, `key:ArrowUp`           |
| `pointer:<button>`                | Un bouton du pointeur : `pointer:0`                            |
| `pointer:wheel`                   | La molette, un axe : les crans de la frame                     |
| `gamepad:<button>`                | Un bouton de manette : `gamepad:south`, `gamepad:rightTrigger` |
| `gamepad:<axis>`                  | Un axe de stick, à travers sa zone morte : `gamepad:leftX`     |
| `gamepad:leftStick`, `rightStick` | Un stick, pour un vecteur (comme bouton : le stick enfoncé)    |

- **Plusieurs liaisons** par action : la plus forte l'emporte — le clavier
  et un stick ne s'additionnent pas. Un bouton est enfoncé lorsque l'un de
  ses contrôles l'est.
- **Les quatre touches** d'un vecteur sont normalisées : la diagonale n'est
  pas plus rapide.
- **Un vecteur va vers le haut** : y est positif vers l'avant, alors que
  l'axe brut d'un stick est positif vers le bas. La liaison d'un stick le
  retourne.
- **Toutes les manettes** pilotent les actions par défaut. Pour un jeu avec
  une manette par joueur, `new ActionMap(input, definitions, { gamepad: 1 })`
  ne lit que la deuxième.

### Modifier et enregistrer les liaisons

```ts
actions.rebind('jump', ['key:KeyJ', 'gamepad:east']);
localStorage.setItem('bindings', JSON.stringify(actions));

// Later: the saved bindings replace those of the definitions.
const saved = JSON.parse(localStorage.getItem('bindings') ?? '{}');
const restored = new ActionMap(input, definitions, { bindings: saved });
```

## Tests et rejeux

`FakeInputSource` est une source pilotée par le code : `keyDown(code)`,
`keyUp(code)`, `connectGamepad()`, `setButton()`, `setAxis()`, et `sink`
pour le pointeur. Elle teste la logique d'une application sans navigateur
ni fenêtre, et rejoue des entrées enregistrées.

```ts
const source = new FakeInputSource();
const input = new Input(source);
source.keyDown('KeyW');
input.update();
expect(actions.vector('move')).toEqual({ x: 0, y: 1 });
```

## Une source à soi

Une `InputSource` écrit les événements dans l'`InputSink` que `Input` donne
à son `attach()`, et remplit les états des manettes dans
`readGamepads(out)`, en réutilisant les objets de `out` : rien n'est alloué
par frame. Un écran tactile, un rejeu réseau ou une autre bibliothèque de
fenêtrage sont une source de plus.

## Pas encore

Les vibrations, le verrouillage du pointeur (mouvements relatifs, pour une
vue à la première personne) et les contextes d'actions (un menu, un jeu) ne
sont pas encore là ; l'API leur laisse de la place.
