---
title: Fenêtre native
description: Exécuter une scène en dehors du navigateur, dans Node, sur WebGPU (Dawn) ou Vulkan.
sidebar:
  order: 4
---

Les scènes du navigateur s'exécutent aussi dans une fenêtre native, dans
Node : les matériaux, les meshes et le renderer sont les mêmes ; le moteur, la
fenêtre et la surface changent. Linux est pris en charge pour l'instant ; le
code natif est écrit pour être portable (CMake, C++20, SDL3, Node-API).

## Deux backends

| Backend         | Moteur                                      | Surface               | Présentation                                                          |
| --------------- | ------------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| WebGPU sur Dawn | `createDawnEngine()` (`@fdw/engine-native`) | `DawnWindowSurface`   | Par copie : rendu dans une texture, relu, puis affiché par la fenêtre |
| Vulkan 1.3      | `VulkanEngine` (`@fdw/engine-vulkan`)       | `VulkanWindowSurface` | Une swapchain, sans copie                                             |

Dawn est le moyen le plus simple de commencer : il ne nécessite aucun SDK. Sa
copie coûte une ou deux images de latence, ce qui convient aux outils et au
développement. Vulkan présente directement, et exécute le moteur sans WebGPU
entre les deux.

## Compiler les addons natifs

Les fenêtres proviennent d'un addon Node au-dessus de SDL3, compilé avec
CMake. Il vous faut CMake et un compilateur C/C++20 ; SDL3 est téléchargé lors
de la première compilation.

```sh
npx nx run engine-native:build-native
```

Pour Vulkan, installez le [SDK Vulkan](https://vulkan.lunarg.com/sdk/home)
(les en-têtes, volk, VMA, le compilateur de shaders DXC et la couche de
validation), configurez son environnement, puis compilez l'addon Vulkan :

```sh
source <sdk>/setup-env.sh                 # sets VULKAN_SDK
npx nx run engine-vulkan:build-native
```

Sans `VULKAN_SDK`, l'addon Vulkan n'est pas compilé, et les tests Vulkan sont
ignorés. [Compilations natives](/fdw-engine/fr/contributing/native-builds/)
donne les détails.

## Lancer la démo native

`apps/demo-native` exécute les scènes de la démo (`shadows`, `pbr`) :

```sh
npx nx run demo-native:start -- shadows              # WebGPU on Dawn
npx nx run demo-native:start -- shadows --vulkan     # Vulkan
```

Ses options :

| Option         | Effet                                                           |
| -------------- | --------------------------------------------------------------- |
| `--vulkan`     | Vulkan au lieu de Dawn                                          |
| `--validation` | La couche de validation Khronos (Vulkan), ses messages à la fin |
| `--no-vsync`   | Effectue le rendu aussi vite que possible, pour mesurer         |
| `--frames <n>` | S'arrête après `n` images                                       |
| `--hidden`     | Masque la fenêtre (tests)                                       |

Échap ou la fermeture de la fenêtre quitte l'application. Le titre affiche la
fréquence d'images.

## Dans votre application

Une scène écrite pour le navigateur s'exécute sans modification ; seule son
initialisation diffère. Sur Dawn :

```ts
import {
  createDawnEngine,
  DawnWindowSurface,
  NativeWindow,
  runLoop,
} from '@fdw/engine-native';
import { Renderer } from '@fdw/engine-core';

const engine = await createDawnEngine();
const window = new NativeWindow({ title: 'My app', width: 1280, height: 720 });
const surface = new DawnWindowSurface(window);
await surface.init(engine);
const renderer = new Renderer(engine.backend!);

// runLoop replaces requestAnimationFrame: it dispatches the window events,
// calls the frame, and lets the Node event loop run.
const loop = runLoop(
  (now) => renderer.render({ items, camera, surface, time: now / 1000 }),
  // At most two frames in flight.
  { throttle: () => surface.throttle() },
);
window.addEventListener('close', () => loop.stop());
await loop.done;

surface.destroy();
window.destroy();
await engine.destroy();
```

Sur Vulkan, le moteur et la surface changent, et la fenêtre est créée pour
Vulkan :

```ts
import { NativeWindow, runLoop, VulkanWindowSurface } from '@fdw/engine-native';
import { VulkanEngine } from '@fdw/engine-vulkan';

const engine = new VulkanEngine({ validation: true });
await engine.init();
const window = new NativeWindow({
  title: 'My app',
  width: 1280,
  height: 720,
  vulkan: true,
});
const surface = new VulkanWindowSurface(window, { vsync: true });
await surface.init(engine);

// The swapchain sets the pace: no throttle.
const loop = runLoop((now) => renderer.render({ items, camera, surface }));
```

La fenêtre transmet ses événements sous forme d'événements DOM : `resize`,
`keydown` / `keyup`, `pointermove`, `pointerdown`, `pointerup`, `wheel`,
`close`. Ses `width` et `height` suivent sa taille en pixels, et la surface
suit la fenêtre.

Exécutez les sources TypeScript avec un loader comme
[jiti](https://github.com/unjs/jiti) : `node --import jiti/register main.ts`.
Le [guide Natif](/fdw-engine/fr/guides/native/) explique le fonctionnement des
deux modes de présentation.
