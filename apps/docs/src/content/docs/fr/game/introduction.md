---
title: Le jeu
description: Un petit jeu construit pas à pas sur le moteur, dans le navigateur et dans une fenêtre native.
sidebar:
  order: 1
---

Ce tutoriel construit un petit jeu, une étape à la fois : un **labyrinthe vu
de dessus**, exploré par un personnage portant une **lampe torche**, dans le
noir — seul ce qu'éclaire la lampe est visible. Chaque étape est jouable, et
ajoute une partie du moteur :

| Étape                                                 | Contenu                                                                                                             | Moteur                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [1. Le labyrinthe](/fdw-engine/fr/game/maze/)         | Un labyrinthe généré de milliers de nœuds, une caméra qui le survole, une vue de dessus de ce que la caméra retient | Scènes, nœuds statiques, culling, render graph                 |
| [2. Le personnage](/fdw-engine/fr/game/character/)    | Un personnage déplacé au clavier, qui heurte les murs, suivi par la caméra                                          | Nœuds, hiérarchie, requêtes par volumes                        |
| [3. La lampe torche](/fdw-engine/fr/game/flashlight/) | Un spot porté par le personnage, orienté à la souris, dans le noir                                                  | Lumières et ombres limitées à la vue                           |
| [4. Le jeu](/fdw-engine/fr/game/the-game/)            | Des gemmes à ramasser, des ennemis qui errent, des lignes de vue, une carte révélée par l'exploration               | Le noyau ECS et ses systèmes, rayons, mises à jour de textures |

## Où se trouve le code

Le code du jeu se trouve dans `packages/demo-scenes/src/maze/`, partagé par :

- la démo navigateur : `npx nx serve demo`, puis la route **Maze** ;
- la démo native : `npx nx run demo-native:start -- maze` (WebGPU sur Dawn,
  ou `--vulkan`), `-- maze-1` à `-- maze-3` pour les premières étapes ;
- les pages de ce tutoriel, où chaque étape s'exécute en direct.

Une étape est une `SceneFactory` : une fonction qui reçoit le backend, la
surface, et un contexte — d'où viennent les événements du clavier et de la
souris, et où afficher une ligne d'information — et qui renvoie une fonction
`frame(time)`. La même fonction s'exécute dans une page, dans la démo et dans
une fenêtre native : les événements d'une fenêtre native sont eux aussi des
événements DOM.

```ts
export const createMazeStep1: SceneFactory = (
  backend,
  surface,
  context = {}
) => {
  // … build the game …
  return {
    frame: (time) => {
      /* … update, then render … */
    },
    destroy: () => {
      /* … */
    },
  };
};
```

## Avant de commencer

Les tutoriels de ce site, en particulier [Une scène](/fdw-engine/fr/tutorials/scene/),
présentent ce qu'utilise le jeu : les nœuds, les nœuds statiques, le renderer
qui dessine une scène.
