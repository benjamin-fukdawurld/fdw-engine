---
title: Natif
description: Comment le moteur s'exécute dans Node, présente dans des fenêtres natives, et pilote Vulkan.
sidebar:
  order: 7
---

En dehors du navigateur, le moteur s'exécute dans **Node**, avec du code
natif dans des **addons**. Le TypeScript du moteur est inchangé : seuls
l'engine et la surface sont natifs.

## Les couches

```
@fdw/engine-native (TS) ──► fdw_native.node (C, Node-API) ──► fdw_window (C++, C API) ──► SDL3
@fdw/engine-vulkan (TS) ──► fdw_vulkan.node (C, Node-API) ──► fdw_vulkan (C++20, C API) ──► Vulkan, DXC
```

- Les **bibliothèques** (`fdw_window`, `fdw_vulkan`) font le travail,
  derrière une API C (`native/include/fdw/*.h`). Un autre hôte — une
  application native, une FFI — peut les utiliser sans Node.
- Les **addons** sont de fines liaisons Node-API, en C. Node-API a une ABI
  stable : un addon compilé une fois fonctionne sur toutes les versions de
  Node.
- L'ensemble est compilé par CMake, en C++20, pour la portabilité. Linux est
  pris en charge aujourd'hui.

## Fenêtres et boucle

`NativeWindow` est une fenêtre SDL3. Ses événements sont des événements DOM
(`NativeWindowEvent`) : `close`, `resize`, `keydown`, `keyup`,
`pointermove`, `pointerdown`, `pointerup`, `wheel`, `blur` (le focus du
clavier a été perdu), et `gamepadconnected`, `gamepaddisconnected`, envoyés
à toutes les fenêtres. Les événements de touche donnent `key` (le nom de la
touche dans la disposition du clavier) et `code` (sa position, comme le
`code` du DOM). `width` et `height` sont en pixels ; `title` et `vsync`
peuvent changer à tout moment.

Les manettes sont lues à la demande : `NativeWindow.gamepads()` les liste,
`NativeWindow.readGamepad(id, buttons, axes)` en lit une dans la disposition
standard de la Gamepad API. Le `NativeInputSource` de
`@fdw/engine-input-native` les utilise : voir
[Entrées](/fdw-engine/fr/guides/input/).

`runLoop(frame, { throttle })` remplace `requestAnimationFrame` : chaque tour
distribue les événements des fenêtres, appelle `frame(now)`, attend
`throttle()` s'il est fourni, puis rend la main à la boucle d'événements de
Node, de sorte que les promesses, les timers et les E/S s'exécutent entre
les frames. Elle renvoie `{ stop(), done }`.

## Dawn : présentation par copie

`createDawnEngine()` renvoie un `WebGpuEngine` reposant sur
[Dawn](https://dawn.googlesource.com/dawn), via le package npm `webgpu`. Le
Dawn de npm ne peut pas présenter dans une fenêtre, donc
`DawnWindowSurface` :

1. rend la frame dans une texture ;
2. la copie dans un buffer, relu de manière asynchrone ;
3. transmet les pixels à la fenêtre, qui les affiche.

Un anneau de buffers de relecture maintient le GPU occupé ; `throttle()`
limite le nombre de frames en vol (2). Le coût est une copie et une ou deux
frames de latence : acceptable pour les outils et le développement, pas pour
un jeu. Compiler Dawn avec sa propre swapchain le supprimerait.

## Vulkan

`@fdw/engine-vulkan` implémente le `RenderBackend` sur Vulkan 1.3 :

- **Shaders** : les programmes sont générés en HLSL (Shader Model 6, HLSL 2021) par `HlslCodegen`, puis compilés en SPIR-V par DXC, chargé à
  l'exécution.
- **Commandes** : les encodeurs écrivent les commandes d'une frame sous forme
  de mots de 32 bits ; `submit` les rejoue dans un command buffer en un seul
  appel natif.
- **Synchronisation** : comme en WebGPU, la bibliothèque suit la dernière
  utilisation de chaque texture et de chaque buffer, et insère les
  barrières : avant une passe de rendu pour ses attachments et ses
  ressources (ses commandes sont lues à l'avance), avant chaque dispatch pour
  ses groupes.
- **Écritures** : `buffer.write` et les envois de textures suivent le
  `queue.writeBuffer` de WebGPU : copiés immédiatement, appliqués dans
  l'ordre de la file avant les commandes suivantes.
- Les **soumissions** sont ordonnées par un timeline semaphore ; les
  ressources détruites sont libérées une fois que le GPU en a terminé avec
  elles.
- La **mémoire** est allouée avec VMA, les fonctions Vulkan chargées avec
  volk.

`VulkanWindowSurface` présente via une **swapchain** : FIFO avec `vsync`,
mailbox ou immediate sans ; recréée lorsque la fenêtre est redimensionnée ;
au plus deux frames en vol. La fenêtre fournit ses handles natifs (X11,
Wayland, Win32, Cocoa) à la surface.

`new VulkanEngine({ validation: true })` active la couche de validation
Khronos lorsqu'elle est installée ; `engine.device.takeMessages()` renvoie
ses messages depuis le dernier appel.

## Variables d'environnement

| Variable               | Effet                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| `VULKAN_SDK`           | Définie par le `setup-env.sh` du SDK : nécessaire pour compiler l'addon Vulkan |
| `FDW_DXC_LIBRARY`      | La bibliothèque DXC à charger (`libdxcompiler`)                                |
| `FDW_NATIVE_ADDON`     | Charge l'addon de fenêtrage depuis un autre chemin                             |
| `FDW_VULKAN_ADDON`     | Charge l'addon Vulkan depuis un autre chemin                                   |
| `NODE_API_INCLUDE_DIR` | Les en-têtes Node-API utilisés pour compiler les addons                        |

## Pour aller plus loin

La conception, ses alternatives (Deno, Electron, un hôte natif) et les
suites — Windows et macOS, addons précompilés, Direct3D 12 — sont décrites
dans `design/native-backends.md` (en français).
