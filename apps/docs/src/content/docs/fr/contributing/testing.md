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

| Fichier                  | Backend                                | Nécessite                                        |
| ------------------------ | -------------------------------------- | ------------------------------------------------ |
| `dawn.spec.ts`           | WebGPU sur Dawn, dans Node             | le paquet `webgpu` (installé)                    |
| `webgl2.browser.spec.ts` | WebGL2, dans Chromium headless         | `npx playwright install chromium-headless-shell` |
| `vulkan.spec.ts`         | Vulkan, avec la couche de validation   | le SDK Vulkan, et l’addon compilé                |
| `hlsl.spec.ts`           | Chaque programme de la suite, via HLSL | le SDK Vulkan (DXC, spirv-val, spirv-cross)      |

```sh
source <sdk>/setup-env.sh     # for the Vulkan and HLSL tests
npx nx test rendering-tests
```

Sans le SDK, les tests Vulkan et HLSL sont ignorés, pas en échec. Sur
Vulkan, un test échoue si la couche de validation signale quoi que ce soit.
`hlsl.spec.ts` enregistre les programmes compilés par la suite, compile
chacun d’eux avec DXC, valide le SPIR-V avec `spirv-val`, et compare les
offsets des uniforms du layout avec la réflexion de `spirv-cross`.

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

Les fichiers `*.bench.ts` mesurent le coût CPU du renderer et du render
graph sur le faux backend : `npx vitest bench` dans `packages/engine-core`.
Lancez-les avant et après une modification sur un chemin critique.

## Avant de soumettre

```sh
npx nx affected -t typecheck lint test
npx nx run docs:build        # if the documentation changed
```
