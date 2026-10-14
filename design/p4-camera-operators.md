# P4. Les opérateurs de caméra

_Fait_ (14 octobre 2026), avec son tutoriel « Navigation de la caméra ». Premier pas des contrôleurs de caméra de la [roadmap](roadmap.md#p4-caméras-entrées-ordonnanceur--démo-fps) : naviguer dans une scène au clavier et à la souris, ou à la manette, avec des contrôles réaffectables.

## 1. Résumé

Un package `@fdw/engine-camera`, en TypeScript pur, dépendant du seul `engine-input`. Deux opérateurs :

- `FlyOperator` : vol libre (`fly`) ou marche (`walk`, à l'horizontale, comme un FPS) ;
- `OrbitOperator` : autour d'un pivot (CAO, stratégie), avec le décalage de la vue et le zoom.

Ils lisent des **actions** nommées (`ActionMap`), jamais des touches : `FlyActions` et `OrbitActions` sont les définitions par défaut, que l'application réaffecte (`rebind`), sauvegarde (`toJSON`) et restaure (option `bindings`). À la manette, par défaut : **déplacement au stick gauche, orientation au stick droit**.

## 2. Les choix

| Question              | Choix                                                                                                                                  | Pourquoi                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| La cible              | Une interface structurelle `CameraTarget` : `position`, `rotation`, `projection` facultative                                           | Une `Camera` d'engine-core et la `Transform` d'un nœud de scène conviennent telles quelles ; pas de dépendance au rendu  |
| L'état                | L'opérateur garde le sien (position ou pivot, lacet, tangage), qu'il écrit dans la cible                                               | Pas de décomposition d'un quaternion ; deux opérateurs sur une caméra reprennent chacun où ils l'avaient laissée         |
| Les entrées           | Des actions `ActionMap` ; `names` associe les intentions de l'opérateur aux actions d'une application                                  | Réaffectable sans code dans l'opérateur ; une application partage sa table                                               |
| La souris             | Un nouveau contrôle `pointer:delta` (et `pointer:deltaX`, `deltaY`) dans `engine-input`, actif tant qu'un bouton est maintenu (`drag`) | Le déplacement de la frame, distinct d'une vitesse : les sticks sont multipliés par `dt`, pas le pointeur                |
| L'échelle du pointeur | En hauteurs de surface, la largeur multipliée par l'aspect de la projection                                                            | Un pixel tourne autant dans les deux directions ; le décalage suit exactement le pointeur (champ de vision de la caméra) |
| La convention         | Lacet autour de y (positif : à gauche), puis tangage autour de x ; la caméra regarde vers -z                                           | Celle des caméras du moteur et du labyrinthe                                                                             |

Écarté : un opérateur qui lit directement `Input` (des touches figées dans le code), et des opérateurs qui additionnent les liaisons (l'`ActionMap` garde déjà la plus forte).

## 3. Les liaisons par défaut

| Intention                   | Clavier, souris                  | Manette              |
| --------------------------- | -------------------------------- | -------------------- |
| Vol : `move`                | WASD (ZQSD en AZERTY)            | Stick gauche         |
| Vol : `look`                | Flèches ; `drag` : bouton 0 ou 2 | Stick droit          |
| Vol : `lift`                | Q, E                             | Gâchettes            |
| Vol : `run`                 | Shift                            | Stick gauche enfoncé |
| Orbite : `orbit`            | Flèches ; `orbitDrag` : bouton 0 | Stick droit          |
| Orbite : `move` (pivot)     | WASD                             | Stick gauche         |
| Orbite : `panDrag`          | Bouton 2 ou 1                    | —                    |
| Orbite : `zoom`, `zoomStep` | E, Q ; molette                   | Gâchettes            |

## 4. Les tests

`operators.spec.ts`, avec `FakeInputSource` : les sticks, les touches, la course, le pointeur glissé (mis à l'échelle de l'aspect), la marche horizontale, les limites du tangage et de la distance, le décalage qui suit le pointeur, les liaisons réaffectées et les noms d'actions. L'exemple de la documentation a son image de référence (WebGPU, WebGL2).

## 5. La suite

Les autres contrôleurs de P4 : TPS (bras à ressort, collisions), stratégie et isométrique (contraintes au plan XZ), le zoom vers le curseur, les mouvements lissés (ressorts amortis), les transitions entre caméras. Le verrouillage du pointeur (vue subjective sans bouton maintenu) est fait : `FlyActions` lie `pointer:locked` à `drag` ([p4-input.md](p4-input.md)). Le labyrinthe pourra remplacer ses `FlyCamera` et `FollowCamera`.
