---
title: Installation
description: Mettre en place l'espace de travail, lancer les démos et créer une application sur le moteur.
sidebar:
  order: 2
---

Le moteur est développé dans un monorepo [Nx](https://nx.dev), avec des
workspaces npm. Ses packages ne sont pas encore publiés : une application vit
dans l'espace de travail, à côté d'eux.

## Prérequis

- **Node.js 20 ou plus récent** (24 recommandé) et npm.
- **Un navigateur** : un navigateur compatible WebGPU (Chrome ou Edge récent,
  Firefox Nightly, Safari Technology Preview), ou n'importe quel navigateur
  WebGL2 : le calcul y est émulé, sans dispatchs indirects.
- Pour les backends natifs uniquement : CMake, un compilateur C/C++20 et, pour
  Vulkan, le SDK Vulkan. Voir [Fenêtre native](/fdw-engine/fr/getting-started/native/).

## Récupérer l'espace de travail

```sh
git clone https://github.com/benjamin-fukdawurld/fdw-engine.git
cd fdw-engine
npm install
```

Vérifiez que tout compile et que les tests passent :

```sh
npx nx run-many -t typecheck lint test
```

## Lancer les démos

La démo navigateur est une série d'exemples, d'un premier triangle jusqu'au
PBR et aux ombres :

```sh
npx nx serve demo        # http://localhost:4200
```

Ses routes `material-graph`, `loading-model`, `pbr` et `shadows` fonctionnent
sur les deux backends navigateur : changez de backend avec les boutons de
l'en-tête, ou avec `?backend=webgl2`.

Cette documentation est elle aussi une application de l'espace de travail :

```sh
npx nx run docs:dev      # http://localhost:4321/fdw-engine/
```

## Créer une application

Une application est un dossier de `apps/` contenant un `package.json` qui
déclare les packages qu'elle utilise :

```json title="apps/my-app/package.json"
{
  "name": "@fdw-engine/my-app",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "@fdw/engine-backend": "0.0.1",
    "@fdw/engine-core": "0.0.1",
    "@fdw/engine-shader": "0.0.1",
    "@fdw/engine-webgl2": "0.0.1",
    "@fdw/engine-webgpu": "0.0.1"
  }
}
```

Après `npm install`, les packages sont des liens vers `packages/*`. Ils
exportent leurs sources TypeScript : construisez l'application avec un bundler
qui compile le TypeScript, comme [Vite](https://vite.dev), qu'utilise
`apps/demo`.

```ts title="apps/my-app/src/main.ts"
import { Renderer } from '@fdw/engine-core';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

const engine = new WebGpuEngine();
await engine.init();
// …
```

Lancez ensuite `npx nx sync` : Nx ajoute les références de projet TypeScript
des dépendances, afin que `npx nx run my-app:typecheck` vérifie l'application
avec les packages.

Les packages dont dépendre :

| Package              | Pour                                                         |
| -------------------- | ------------------------------------------------------------ |
| `@fdw/engine-core`   | Caméras, transformations, lumières, meshes, matériaux, rendu |
| `@fdw/engine-shader` | Material graphs et graphes de calcul                         |
| `@fdw/engine-webgpu` | WebGPU, dans le navigateur ou sur Dawn                       |
| `@fdw/engine-webgl2` | WebGL2, pour les navigateurs sans WebGPU                     |
| `@fdw/engine-native` | Fenêtres natives dans Node, Dawn                             |
| `@fdw/engine-vulkan` | Vulkan dans Node                                             |

`@fdw/engine-backend` contient les interfaces partagées par les backends
(`Engine`, `Surface`, `RenderBackend`) et les types mathématiques : dépendez-en
dès que vous écrivez du code qui ne se soucie pas du backend sur lequel il
s'exécute.

## Et ensuite

[Votre première scène](/fdw-engine/fr/getting-started/first-scene/) dessine un
cube éclairé, pas à pas.
