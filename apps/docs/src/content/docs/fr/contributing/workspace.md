---
title: Espace de travail
description: L’organisation du monorepo, Nx, et les commandes du quotidien.
sidebar:
  order: 2
---

## Organisation

```
apps/
  demo/             The browser demo (React, Vite)
  demo-native/      The demo scenes in a native window (Node)
  docs/             This documentation (Astro, Starlight)
packages/
  engine-*/         The engine
  demo-scenes/      Scenes shared by the demos
tests/
  rendering/        The rendering suite shared by the backends
design/             Design documents (in French)
tools/native/       The build script shared by the native addons
```

L’espace de travail utilise les **npm workspaces** (`packages/*`,
`apps/*`) : les paquets sont liés dans `node_modules/@fdw` et exportent
leurs sources TypeScript. **Nx** exécute les tâches, met leurs résultats en
cache, et connaît les dépendances entre projets grâce à leur
`package.json` et à leurs références TypeScript.

## Commandes

| Commande                                  | Effet                                        |
| ----------------------------------------- | -------------------------------------------- |
| `npx nx run-many -t typecheck lint test`  | Vérifie tout                                 |
| `npx nx affected -t typecheck lint test`  | Seulement les projets modifiés depuis `main` |
| `npx nx test engine-shader`               | Les tests d’un projet                        |
| `npx nx serve demo`                       | La démo navigateur, sur le port 4200         |
| `npx nx run docs:dev`                     | Cette documentation, sur le port 4321        |
| `npx nx run docs:build`                   | Le site statique, dans `apps/docs/dist`      |
| `npx nx run engine-native:build-native`   | L’addon de fenêtres (CMake)                  |
| `npx nx run engine-vulkan:build-native`   | L’addon Vulkan (nécessite `VULKAN_SDK`)      |
| `npx nx run demo-native:start -- shadows` | La démo native                               |
| `npx nx graph`                            | Le graphe de dépendances des projets         |

Dans un paquet, `npx vitest --watch` exécute ses tests en mode watch, et
`npx vitest bench` ses benchmarks (`*.bench.ts`).

## Références de projets TypeScript

Chaque projet a un `tsconfig.json` qui référence son `tsconfig.lib.json`
(ou `tsconfig.app.json`) et son `tsconfig.spec.json` ; les références entre
projets suivent leurs dépendances. Après avoir ajouté une dépendance à un
`package.json` :

```sh
npm install
npx nx sync    # updates the TypeScript references
```

`nx sync` déduit les références des dépendances du `package.json` : un
paquet importé mais non déclaré perd sa référence.

## Ajouter un paquet

Créez `packages/<name>/` avec un `package.json` (nom `@fdw/<name>`,
`exports` pointant vers `./src/index.ts`, avec la condition
`@fdw-engine/source`), un `project.json`, les fichiers tsconfig,
`vitest.config.mts` et un `README.md`. Copiez un paquet
existant comme `engine-webgl2` ; un paquet qui produit des sorties de build
(un addon natif) ajoute un `eslint.config.mjs` qui les ignore. Ajoutez
ensuite son chemin à `tsconfig.base.json`, lancez `npm install` et
`npx nx sync`, et ajoutez-le aux points d’entrée de la référence de l’API
dans `apps/docs/astro.config.mjs`.
