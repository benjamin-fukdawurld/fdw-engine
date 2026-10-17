---
title: Tests
description: Tests unitaires, suite de rendu partagée par les backends, validation des shaders et benchmarks.
sidebar:
  order: 4
---

Les tests utilisent [Vitest](https://vitest.dev). `npx nx run-many -t test`
les exécute tous ; `npx nx test <project>` un seul projet.

## Tests unitaires

À côté du code, sous la forme `src/**/*.spec.ts`. Ils n’ont besoin d’aucun
GPU :

- **engine-shader** : des graphes construits, validés et compilés,
  vérifiés sur l’IR (instructions, étages, layout) ou sur les diagnostics.
- **engine-core** : le renderer et le render graph sur un **faux backend**
  (`src/testing/fakeBackend.ts`), qui enregistre les ressources créées et
  les commandes encodées : ce qui est dessiné, dans quel ordre, avec quels
  buffers.
- **Générateurs de code** : le code généré, sur de petits programmes.

## La suite de rendu

`tests/rendering` rend les mêmes scènes sur chaque backend, à travers tout
le moteur, dans des surfaces hors écran, et compare les **pixels**. Une
fonctionnalité qui change ce qui est dessiné ajoute un test à
`src/suite.ts` : il s’exécute alors sur tous les backends à la fois.

```ts
it('computes the functions of screen-uv per pixel', async () => {
  drawFullscreen(renderer, (g) => {
    /* … */
  });
  const pixel = await pixelsOf();
  expectColor(pixel(32, 32), [3, 0, 0, 255]);
});
```

| Fichier                  | Backend                                             | Nécessite                                                     |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------- |
| `dawn.spec.ts`           | WebGPU sur Dawn, dans Node                          | le paquet `webgpu` (installé)                                 |
| `webgl2.browser.spec.ts` | WebGL2, dans Chromium headless                      | `npx playwright install chromium-headless-shell`              |
| `vulkan.spec.ts`         | Vulkan, avec la couche de validation                | le SDK Vulkan, et l’addon compilé                             |
| `programs.spec.ts`       | Chaque programme de la suite, en HLSL et en GLSL ES | le SDK Vulkan (DXC, spirv-val, spirv-cross, glslangValidator) |

```sh
source <sdk>/setup-env.sh     # for the Vulkan, HLSL and GLSL tests
npx nx test rendering-tests
```

Sans le SDK, les tests Vulkan, HLSL et GLSL sont ignorés, pas en échec —
sauf s’ils sont requis (voir
[Intégration continue](#intégration-continue)). Sur Vulkan, un test échoue
si la couche de validation signale quoi que ce soit. `programs.spec.ts`
enregistre les programmes compilés par la suite, puis :

- compile chacun d’eux en HLSL avec DXC, valide le SPIR-V avec
  `spirv-val`, et compare les offsets des uniforms du layout avec la
  réflexion de `spirv-cross` ;
- les génère en GLSL ES 3.00 (les étapes de calcul comme les dessins qui
  les émulent en WebGL2), puis les valide et les lie avec
  `glslangValidator`, plus strict que les compilateurs des navigateurs.

Les tests de pixels vérifient des valeurs **exactes** là où le GPU les
calcule exactement (effacements, couleurs non éclairées), et des
intervalles ailleurs (bords, filtrage) : les GPU arrondissent
différemment.

## Les paquets natifs

`engine-native` et `engine-vulkan` testent leur partie TypeScript avec des
addons mock, et leur partie native sur le vrai GPU lorsque les addons sont
compilés. Les cibles `test` dépendent de `build-native`, et leurs entrées
incluent `VULKAN_SDK` : Nx les relance quand le SDK change.

## Benchmarks

Les fichiers `*.bench.ts` mesurent le coût CPU du renderer, du render
graph, de la scène, de l’ECS, de la géométrie et du compilateur de
shaders, sur le faux backend : `npx vitest bench` dans un paquet.
Lancez-les avant et après une modification sur un chemin critique :

```sh
npm run bench                                  # every package: bench.json
git stash && npm run bench -- base.json && git stash pop
npm run bench:compare -- base.json bench.json  # a table of the changes
```

Sur chaque pull request, le workflow **Benchmarks** fait de même dans la
CI : la modification et sa base mesurées dans le même job, comparées dans
le résumé de l’exécution. Un benchmark est marqué plus lent ou plus rapide
au-delà de 20 % et au-delà des marges d’erreur des deux mesures. Les
runners sont partagés et bruités : le workflow n’échoue jamais, le tableau
est un indice pour regarder de plus près.

## Intégration continue

Chaque pull request s’exécute sur GitHub Actions (`.github/workflows/`),
et doit être au vert pour être fusionnée dans `main` :

| Vérification              | Ce qu’elle exécute                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Check`                   | Le formatage, puis typecheck, lint et tests des projets affectés par la modification                               |
| `Native and rendering`    | Les projets marqués `gpu`, lorsqu’ils sont affectés : les addons, Dawn et la suite de rendu, sur des GPU logiciels |
| `Build the documentation` | Le site, et ses liens et ancres internes                                                                           |

Les runners n’ont pas de GPU : Vulkan s’exécute sur **lavapipe** (le
Vulkan logiciel de Mesa), WebGL2 dans Chromium sur **SwiftShader**, les
fenêtres dans un écran virtuel (Xvfb). Les projets qui ont besoin d’un
GPU, d’un SDK ou d’un écran portent le tag `gpu` (`engine-webgpu`,
`engine-native`, `engine-vulkan`, `rendering-tests`).

Sur un poste de travail, une suite dont le GPU, le SDK, l’addon ou l’écran
manque est ignorée. Dans la CI, `FDW_REQUIRE_SUITES` liste les suites qui
doivent s’exécuter (`vulkan,dawn,hlsl,glsl,window`) : une suite absente
échoue au lieu de passer silencieusement. Une nouvelle suite de ce type
appelle `canRun(name, ready, reason)` de `@fdw/engine-backend/testing`.

Pour exécuter les suites GPU comme la CI, sur lavapipe :

```sh
source <sdk>/setup-env.sh
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json \
FDW_REQUIRE_SUITES=vulkan,dawn,hlsl,glsl,window \
npx nx run-many -t test -p tag:gpu
```

### Les images de référence des exemples

Chaque exemple interactif de la documentation est rendu dans Chromium
headless, sur WebGL2 et sur WebGPU, tous deux sur SwiftShader, et son
canvas comparé à une image de référence (`apps/docs/tests/screenshots/`) :

```sh
npx nx run docs:visual                         # builds the site, compares
npx nx run docs:visual -- --update-snapshots   # writes new references
```

Les exemples s’exécutent avec leur horloge arrêtée et s’arrêtent après
quelques frames (`?time=1.5&frames=10`) : l’image est la même à chaque
exécution.

Quand une modification change ce qu’un exemple dessine, mettez à jour ses
références, regardez-les, et commitez-les avec la modification. Si la CI
rend un peu différemment de votre machine, lancez à la main le workflow
**Documentation** avec **update-screenshots** : il rend les références sur
la machine de la CI et les fournit sous forme d’artefact. Quand une
comparaison échoue, le rapport avec les images de la différence est un
artefact de l’exécution.

## Avant de soumettre

Travaillez sur une branche, et ouvrez une pull request : `main` ne reçoit
que des pull requests squashées.

```sh
npm run format:check         # or npm run format, to fix it
npx nx affected -t typecheck lint test
npx nx run docs:build        # if the documentation changed
npm run docs:links           # then its links
```
