# P4. Les entrées : verrouillage du pointeur, contextes, vibrations

_Fait_ (14 octobre 2026), avec son tutoriel « Contrôles à la première personne » (`tutorials/first-person`, EN et FR, exemple en direct et images de référence). Ce que [input.md §6](input.md#6-hors-du-périmètre-prévu-par-lapi) laissait de côté, et que la vue subjective de la démo FPS demande.

## 1. Résumé

| Fonction                 | API                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Verrouillage du pointeur | `input.lockPointer(locked = true)`, `pointer.locked`, le contrôle `pointer:locked` (un bouton) ; `dx`, `dy` relatifs, `x`, `y` fixes |
| Contextes d'actions      | `ActionMap.enabled` (et l'option `enabled`), `ActionMap.active`                                                                      |
| Vibrations               | `Gamepad.rumble(strong, weak, duration)`, `ActionMap.rumble(…)` : les manettes de la table                                           |

Les sources : deux méthodes **facultatives** de `InputSource`, `setPointerLock(locked)` et `rumble(gamepad, strong, weak, duration)` ; le récepteur gagne `pointerLock(locked)`, et `pointerMove(x, y, dx?, dy?)` reçoit le mouvement relatif quand la source le connaît.

## 2. Les choix

| Question                        | Choix                                                                                                  | Pourquoi                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Les unités du mouvement relatif | Des fractions de la surface, comme `dx` et `dy` avant                                                  | `pointer:delta` et les opérateurs de caméra marchent tels quels, verrouillé ou non         |
| Le mouvement de la frame        | Accumulé depuis les événements (`dx` donné, ou la différence des positions)                            | Verrouillé, la position ne bouge plus ; en natif, `xrel` de SDL est toujours donné         |
| L'état du verrou                | Rapporté par la source (`sink.pointerLock`), figé à `update()`                                         | Le navigateur peut refuser le verrou (pas de geste) et le reprend sur Échap                |
| Le premier mouvement verrouillé | Ignoré par `WebInputSource`                                                                            | Chromium lui donne un saut (jusqu'à la taille de l'écran) : vu dans les tests de l'exemple |
| Regarder sans bouton            | Un contrôle `pointer:locked`, lié à `drag` dans `FlyActions`                                           | Rien à changer dans l'opérateur ; réaffectable                                             |
| Les contextes                   | Une `ActionMap` par contexte, `enabled` ; désactivée, elle lit des zéros                               | Ce que prévoyait input.md ; pas de pile de contextes tant qu'aucun client n'en a besoin    |
| L'appui qui change de contexte  | Une table activée pendant une frame ne lit rien jusqu'au `update()` suivant (`Input.frame`)            | L'Échap qui ouvre un menu ne le referme pas, le clic sur « Play » ne tire pas              |
| Les vibrations                  | Deux moteurs de 0 à 1, une durée en secondes ; la nouvelle remplace l'ancienne ; ignorées sans moteurs | Le modèle commun de `dual-rumble` (Gamepad API) et de `SDL_RumbleGamepad`                  |

## 3. Les implémentations

- **Web** : `requestPointerLock` sur l'élément (la racine du document pour `window`), `pointerlockchange`, `movementX` / `movementY` divisés par la taille de la surface ; `vibrationActuator.playEffect('dual-rumble', …)`, `reset()` pour arrêter. Le verrou demande un geste récent de l'utilisateur : l'appeler dans la frame du clic suffit (activation transitoire).
- **Natif** : `fdw_window_set_relative_mouse` (`SDL_SetWindowRelativeMouseMode`) et `fdw_gamepad_rumble` (`SDL_RumbleGamepad`) dans l'API C ; `NativeWindow.pointerLocked`, `NativeWindow.rumbleGamepad()` ; `NativeInputSource` passe `dx`, `dy` des événements.
- **Tests** : `FakeInputSource` verrouille aussitôt et enregistre les vibrations (`rumbles`).

## 4. Les tests

`Input.spec.ts` (verrou, mouvements relatifs, `pointer:locked`, contextes, vibrations), `WebInputSource.spec.ts` (Pointer Lock API et actionneur factices, le premier mouvement ignoré), `NativeInputSource.spec.ts` et `NativeWindow.spec.ts` (addon factice), `operators.spec.ts` (le `FlyOperator` regarde au pointeur verrouillé). L'exemple a deux images de référence (WebGPU, WebGL2) : le menu à l'ouverture, puis un clic, un tir, le pilier touché.

## 5. La suite

Le texte saisi (input.md §6). Une pile de contextes, ou des priorités entre tables actives en même temps, si un client en a besoin. La démo FPS de P4 réutilisera l'exemple : verrou, tir par rayon, menu de pause.
