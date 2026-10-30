---
title: Builds natifs
description: Compiler les addons natifs, installer le SDK Vulkan, et déboguer le code natif.
sidebar:
  order: 5
---

Deux paquets contiennent du code natif : `engine-native` (fenêtres sur
SDL3, audio sur miniaudio) et `engine-vulkan` (le backend Vulkan). Chacun a un répertoire
`native/` compilé par CMake dans `build/`, par le script partagé
`tools/native/build-addon.mjs`.

## Prérequis

- CMake 3.24 ou ultérieur, et un compilateur C/C++20 : GCC ou Clang,
  Visual Studio 2022 ou ultérieur (sa charge de travail C++) sous Windows.
- Sous Linux, les paquets de développement dont SDL3 a besoin pour ses
  backends vidéo : X11 et/ou Wayland, comme pour tout build de SDL.
- Rien pour les **en-têtes Node-API** : ils viennent de la dépendance de
  développement `node-api-headers`, avec le fichier `.def` dont CMake tire
  la bibliothèque d’import de `node.exe` sous Windows.
  `NODE_API_INCLUDE_DIR` les remplace.
- Pour Vulkan, le **SDK Vulkan**, 1.3 ou ultérieur.

SDL3 et miniaudio sont téléchargés par CMake (`FetchContent`) lors du
premier build, et liés statiquement : l’addon n’en dépend pas à
l’exécution. miniaudio charge le système audio de la machine à la création
d’un moteur (PulseAudio ou ALSA sous Linux), et se replie sur un
périphérique nul sans lui.

## Le SDK Vulkan

Téléchargez l’archive Linux depuis [LunarG](https://vulkan.lunarg.com/sdk/home),
extrayez-la, et chargez son environnement (`source`) dans chaque shell qui
compile ou exécute les tests :

```sh
tar xf vulkansdk-linux-x86_64-<version>.tar.xz -C ~/vulkan
source ~/vulkan/<version>/setup-env.sh   # VULKAN_SDK, PATH, LD_LIBRARY_PATH, VK_LAYER_PATH
```

Ajoutez la ligne `source` à `~/.profile` pour la rendre permanente. Le SDK
fournit les en-têtes, volk, VMA, DXC (`libdxcompiler`, chargé à
l’exécution), `spirv-val`, `spirv-cross` et la couche de validation.

## Compilation

```sh
npx nx run engine-native:build-native
npx nx run engine-vulkan:build-native
```

Ou directement, avec un build de débogage :

```sh
node packages/engine-native/scripts/build.mjs --debug
node packages/engine-vulkan/scripts/build.mjs --debug
```

Sans `VULKAN_SDK`, le build Vulkan est ignoré avec un avertissement. Les
cibles de test et de démarrage dépendent de `build-native`, si bien que Nx
compile les addons quand c’est nécessaire.

## Structure d’un paquet natif

```
native/
  CMakeLists.txt
  include/fdw/<name>.h    The C API of the library
  src/                    The library (C++20), and node_<name>.c, the Node-API binding
scripts/build.mjs         Calls tools/native/build-addon.mjs
src/addon.ts              Loads the addon, and types its functions
```

- La bibliothèque fait le travail et ne sait rien de Node ; le binding
  convertit les arguments et les erreurs.
- La partie TypeScript charge l’addon à la demande (`loadAddon()`), et les
  tests peuvent le remplacer (`setAddon()`) par un mock.
- Les objets Vulkan sont identifiés par des identifiants entiers côté
  TypeScript ; les images sont transmises sous forme de tableaux de mots de
  commande de 32 bits.

## Portabilité

Le code natif est portable par construction : CMake, C++20 sans API
système, SDL3 pour les fenêtres et les handles natifs, dépendances
téléchargées plutôt que prises dans le système. Ce qui dépend de la
plateforme — handles de fenêtre, chemins de bibliothèques — reste
cantonné à quelques endroits isolés. Linux et Windows sont construits et
testés en CI (Windows : Vulkan sur lavapipe, Direct3D 12 sur WARP,
`FDW_D3D12_ADAPTER=warp` sur une machine sans GPU) ; macOS (via MoltenVK)
est prévu, voir `design/p11-windows.md`.

Sous Windows, dans VS Code, Nx Console peut poser `NX_WORKSPACE_ROOT_PATH`
avec un lecteur en minuscule (`c:\…`) : Vitest charge alors deux copies de
lui-même, et chaque test échoue sur « Vitest failed to find the runner ».
Posez-la avec un lecteur en majuscule (`C:\…`) dans le terminal.

## Débogage

- `--validation` sur la démo native, ou
  `new VulkanEngine({ validation: true })` : la couche Khronos vérifie chaque
  appel Vulkan ; `device.takeMessages()` renvoie ses messages.
- Un build `--debug` conserve les symboles : lancez Node sous
  `gdb --args node …` pour déboguer l’addon.
- `FDW_NATIVE_ADDON` et `FDW_VULKAN_ADDON` chargent un addon compilé
  ailleurs.
