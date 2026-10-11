# Les entrées : clavier, souris, manettes

Une API d'entrées **générale**, pensée pour toute application du moteur (jeu, outil, visualiseur, éditeur), dans le navigateur et dans une fenêtre native. Décisions validées : trois packages, des touches physiques, un état lu une fois par frame, des actions nommées et leurs liaisons. Le jeu du labyrinthe en est le premier client, manette comprise.

## 1. Les packages

| Package               | Contenu                                                                                | Dépendances                     |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| `engine-input`        | L'interface des sources, l'état des périphériques (`Input`), les actions (`ActionMap`) | Aucune (ni DOM ni SDL)          |
| `engine-input-web`    | `WebInputSource` : événements DOM d'un élément, Gamepad API                            | `engine-input`                  |
| `engine-input-native` | `NativeInputSource` : événements d'une `NativeWindow`, manettes SDL3                   | `engine-input`, `engine-native` |

Le schéma est celui des backends de rendu : le cœur ne connaît que des interfaces, chaque environnement a son implémentation, et une application n'embarque que ce qu'elle utilise. Les tests du cœur passent par une source factice.

## 2. Les sources

Une source écrit des événements normalisés dans un **récepteur** (`InputSink`) fourni par `Input`, et donne l'état des manettes quand on le lui demande :

```ts
interface InputSource {
  attach(sink: InputSink): void; // commence à écouter
  readGamepads(out: GamepadState[]): number; // l'état des manettes branchées
  detach(): void;
}

interface InputSink {
  keyDown(code: string, key: string): void;
  keyUp(code: string, key: string): void;
  pointerMove(x: number, y: number): void; // de 0 à 1 sur la surface, depuis le haut à gauche
  pointerButton(button: number, down: boolean): void;
  wheel(notches: number): void; // positif : vers le bas, en crans
  blur(): void; // la fenêtre perd le focus : tout est relâché
}
```

- **Clavier** : `code` est la **position physique** de la touche, nommée comme le `code` DOM (`KeyW`, `ArrowUp`, `ShiftLeft`, `Space`) ; `key` est ce qu'elle produit dans la disposition du clavier (« z » sur la touche `KeyW` d'un clavier AZERTY). Les liaisons utilisent `code` : WASD devient ZQSD en AZERTY sans configuration. `key` sert à afficher la touche à l'utilisateur. En natif, SDL donne le scancode (une position physique, comme `code`) : `engine-native` le traduit en nom de `code` DOM.
- **Pointeur** : position normalisée sur la surface (la même en page et en fenêtre native), boutons numérotés comme le DOM (0 principal, 1 milieu, 2 secondaire), molette en crans (100 pixels DOM, ou un cran SDL).
- **Manettes** : sondées, pas reçues en événements. Le navigateur l'exige (`navigator.getGamepads()` à chaque frame) ; SDL donne aussi l'état à la demande. `readGamepads` remplit un tableau réutilisé : rien n'est alloué par frame.

### La disposition standard

Les manettes suivent la disposition « standard », la même dans la Gamepad API (`mapping: 'standard'`) et dans `SDL_Gamepad` :

| Boutons                                                | Axes                                            |
| ------------------------------------------------------ | ----------------------------------------------- |
| `south`, `east`, `west`, `north` (A, B, X, Y sur Xbox) | `leftX`, `leftY`, `rightX`, `rightY`, de -1 à 1 |
| `leftShoulder`, `rightShoulder`                        | y positif vers le bas, comme le DOM et SDL      |
| `leftTrigger`, `rightTrigger` (analogiques, de 0 à 1)  |                                                 |
| `back`, `start`, `guide`, `leftStick`, `rightStick`    |                                                 |
| `dpadUp`, `dpadDown`, `dpadLeft`, `dpadRight`          |                                                 |

Les boutons ont une **valeur** de 0 à 1 (analogique pour les gâchettes) ; un bouton est enfoncé au-delà de 0,5. Une manette sans disposition standard dans le navigateur est ignorée (son ordre de boutons n'a pas de sens connu).

## 3. L'état des périphériques : `Input`

```ts
const input = new Input(new WebInputSource(canvas));
// À chaque frame, avant la logique :
input.update();
input.keyboard.isDown('KeyW');
input.keyboard.pressed('KeyF'); // enfoncée depuis la frame précédente
input.pointer.x; // de 0 à 1
input.pointer.wheel; // les crans de la frame
input.gamepads[0]?.stick('left'); // { x, y }, avec la zone morte
input.lastDevice; // 'keyboard' | 'pointer' | 'gamepad'
```

**Un état par frame.** Les événements arrivent n'importe quand ; `update()` les applique d'un coup, relit les manettes, et fige l'état jusqu'au prochain `update()`. Toute la frame voit le même état : les pas fixes de la logique (plusieurs par frame, ou aucun) lisent les mêmes appuis.

- `pressed` et `released` valent pour la frame où ils ont eu lieu. Un appui plus court qu'une frame (enfoncée puis relâchée entre deux `update()`) donne `pressed` vrai et `isDown` faux : il n'est pas perdu.
- Les répétitions d'une touche maintenue ne sont pas de nouveaux appuis.
- La perte du focus relâche tout : une touche relâchée hors de la fenêtre ne reste pas enfoncée.
- Pour un pas fixe : un appui est vu par tous les pas de sa frame. Une action « une fois par appui » se lit une fois par frame, hors des pas, ou le jeu retient qu'il l'a traitée.

**Zone morte radiale.** Un stick au repos ne revient jamais exactement à 0. `stick()` applique une zone morte sur la longueur du vecteur (0,15 par défaut), puis remet l'échelle de 0 à 1 au-delà : pas de saut à la sortie de la zone, et les diagonales gardent leur direction (une zone morte par axe les rabattrait sur les axes).

**Dernier périphérique utilisé.** Le dernier qui a servi (une touche, un mouvement de souris, un bouton ou un stick hors de sa zone morte) : de quoi choisir entre la visée à la souris et au stick, ou les touches à afficher.

## 4. Les actions : `ActionMap`

Le code d'une application ne devrait pas lire `KeyW` ni `leftX` : il lit **des actions**, liées à des contrôles par une table que l'application déclare, que l'utilisateur peut modifier, et qui se sauvegarde en JSON.

```ts
const actions = new ActionMap(input, {
  move: {
    type: 'vector',
    bindings: [
      { up: 'key:KeyW', down: 'key:KeyS', left: 'key:KeyA', right: 'key:KeyD' },
      {
        up: 'key:ArrowUp',
        down: 'key:ArrowDown',
        left: 'key:ArrowLeft',
        right: 'key:ArrowRight',
      },
      'gamepad:leftStick',
    ],
  },
  flashlight: {
    type: 'button',
    bindings: ['key:KeyF', 'gamepad:west', 'gamepad:rightTrigger'],
  },
  zoom: {
    type: 'axis',
    bindings: [{ negative: 'gamepad:dpadUp', positive: 'gamepad:dpadDown' }],
  },
});
actions.vector('move'); // { x, y }, y vers l'avant
actions.button('flashlight').pressed;
actions.axis('zoom');
```

| Type     | Valeur                                 | Liaisons                                                                                         |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `button` | `down`, `pressed`, `released`, `value` | Des contrôles : touche, bouton de souris, bouton de manette (une gâchette compte au-delà de 0,5) |
| `axis`   | Un nombre                              | Un axe de manette, la molette, ou une paire `{ negative, positive }` de contrôles                |
| `vector` | `{ x, y }`, longueur ≤ 1               | Quatre contrôles `{ up, down, left, right }`, ou un stick                                        |

- **Les contrôles** sont des chaînes : `key:<code>`, `pointer:<bouton>`, `pointer:wheel`, `gamepad:<bouton>`, `gamepad:<axe>`, `gamepad:leftStick` / `rightStick`. Une chaîne se sauvegarde, se compare, s'affiche.
- **Plusieurs liaisons** par action : la plus forte l'emporte (le clavier et le stick ne s'additionnent pas). Quatre touches d'un vecteur sont normalisées : la diagonale n'est pas plus rapide.
- **Un stick comme bouton** : `gamepad:leftStick` est le stick dans un vecteur, le stick enfoncé dans un bouton (le bouton `leftStick` de la disposition standard).
- **Les manettes** : une liaison de manette lit toutes les manettes branchées (la plus forte l'emporte). Un jeu à plusieurs joueurs donnera une manette à chaque `ActionMap` (`gamepad` dans les options) : prévu par l'API, pas utilisé par le labyrinthe.
- **Le vecteur va vers le haut** : `y` positif vers l'avant (W, le stick poussé), alors que l'axe brut d'un stick est positif vers le bas. La liaison d'un stick inverse son y.
- **Modifier les liaisons** : `actions.bindings` (lecture), `actions.rebind(action, bindings)`, `actions.toJSON()` et l'option `bindings` du constructeur pour les recharger.
- **Afficher une liaison** : `input.keyboard.label(code)` donne la touche dans la disposition courante, une fois vue (« Z » pour `KeyW` en AZERTY), le nom du `code` sinon.

## 5. Le natif

`engine-native` ajoute à son API C :

- `code` dans les événements de touche : le scancode SDL traduit en nom de `code` DOM ;
- `SDL_INIT_GAMEPAD` avec la vidéo ; à `SDL_EVENT_GAMEPAD_ADDED`, la manette est ouverte, à `SDL_EVENT_GAMEPAD_REMOVED`, fermée ;
- `fdw_gamepads(ids, capacity)` (les manettes ouvertes) et `fdw_gamepad_read(id, state)` (nom, boutons et axes, dans l'ordre de la disposition standard).

`NativeInputSource` écoute la `NativeWindow` (ses événements DOM, `code` compris) et sonde les manettes à chaque `readGamepads`. Les événements SDL sont lus par `NativeWindow.pollEvents()` (appelé par `runLoop`) : une manette branchée apparaît à la frame suivante.

## 6. Hors du périmètre, prévu par l'API

- Les vibrations (`GamepadHapticActuator`, `SDL_RumbleGamepad`) : une méthode de la source.
- Le verrouillage du pointeur (visée à la souris en vue subjective) : des déplacements relatifs dans le récepteur.
- Les contextes d'actions (menu ou jeu) : plusieurs `ActionMap`, activées ou non.
- Le texte saisi (`beforeinput`, `SDL_EVENT_TEXT_INPUT`) : pour un champ de texte, pas pour un jeu.

## 7. Le labyrinthe

Les étapes 1 à 4 passent à `engine-input` ; l'`Input` de la démo disparaît. Les liaisons :

| Action       | Clavier, souris          | Manette                       |
| ------------ | ------------------------ | ----------------------------- |
| `move`       | WASD (ZQSD), flèches     | Stick gauche                  |
| `run`        | Shift                    | Stick gauche enfoncé          |
| `aim`        | La souris (point au sol) | Stick droit (une direction)   |
| `turn`       | Q et E (A et E)          | Bumpers                       |
| `zoomStep`   | Molette (par crans)      | —                             |
| `zoom`       | —                        | Croix haut et bas (maintenue) |
| `flashlight` | F                        | `west`, gâchette droite       |
| `map`        | M                        | `back`                        |
| `culling`    | C                        | —                             |
| `restart`    | R                        | `start`                       |

Le zoom est deux actions : la molette tourne par crans, une fois, alors que la croix est maintenue — une vitesse, multipliée par la durée de la frame. Une seule action mélangerait un à-coup et une vitesse.

La visée suit le dernier périphérique utilisé : la souris donne un point du sol sous le pointeur, le stick droit une direction autour du personnage, tournée par la caméra.

## 8. Les étapes

1. `engine-input` : sources, `Input`, `ActionMap`, tests avec une source factice.
2. `engine-input-web` : DOM et Gamepad API, tests avec un `EventTarget` et un `navigator` factices.
3. `engine-native` : `code`, les manettes ; `engine-input-native`, tests avec l'addon factice.
4. Le labyrinthe : les étapes 1 à 4, les manettes.
5. La documentation : un guide « Input » (EN, FR), l'API de référence des trois packages, les pages du jeu.
