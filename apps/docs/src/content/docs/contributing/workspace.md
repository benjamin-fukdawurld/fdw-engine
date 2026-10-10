---
title: Workspace
description: The layout of the monorepo, Nx, and the everyday commands.
sidebar:
  order: 2
---

## Layout

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

The workspace uses **npm workspaces** (`packages/*`, `apps/*`): the packages
are linked into `node_modules/@fdw`, and export their TypeScript sources.
**Nx** runs the tasks, caches their results, and knows the dependencies
between projects from their `package.json` and TypeScript references.

## Commands

| Command                                   | Does                                   |
| ----------------------------------------- | -------------------------------------- |
| `npx nx run-many -t typecheck lint test`  | Checks everything                      |
| `npx nx affected -t typecheck lint test`  | Only the projects changed since `main` |
| `npx nx test engine-shader`               | The tests of one project               |
| `npx nx serve demo`                       | The browser demo, on port 4200         |
| `npx nx run docs:dev`                     | This documentation, on port 4321       |
| `npx nx run docs:build`                   | The static site, in `apps/docs/dist`   |
| `npx nx run engine-native:build-native`   | The window addon (CMake)               |
| `npx nx run engine-vulkan:build-native`   | The Vulkan addon (needs `VULKAN_SDK`)  |
| `npx nx run demo-native:start -- shadows` | The native demo                        |
| `npx nx graph`                            | The dependency graph of the projects   |

In a package, `npx vitest --watch` runs its tests in watch mode, and
`npx vitest bench` its benchmarks (`*.bench.ts`).

## TypeScript project references

Each project has a `tsconfig.json` referencing its `tsconfig.lib.json` (or
`tsconfig.app.json`) and its `tsconfig.spec.json`; the references between
projects follow their dependencies. After adding a dependency to a
`package.json`:

```sh
npm install
npx nx sync    # updates the TypeScript references
```

`nx sync` derives the references from the `package.json` dependencies: a
package imported but not declared loses its reference.

## Adding a package

Create `packages/<name>/` with a `package.json` (name `@fdw/<name>`,
`exports` pointing to `./src/index.ts`, with the `@fdw-engine/source`
condition), a `project.json`, the tsconfig files, `vitest.config.mts`,
`typedoc.json` and a `README.md`. Copy an existing package such as
`engine-webgl2`; a package with build outputs (a native addon) adds an
`eslint.config.mjs` ignoring them. Then add its path to `tsconfig.base.json`, run
`npm install` and `npx nx sync`, and add it to the entry points of the API
reference in `apps/docs/astro.config.mjs`.
