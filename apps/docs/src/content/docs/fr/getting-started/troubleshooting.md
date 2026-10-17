---
title: Dépannage
description: Les problèmes courants à l'installation, au build et à l'exécution du moteur, et leurs solutions.
sidebar:
  order: 5
---

## Dans le navigateur

### WebGPU n'est pas disponible

`WebGpuEngine.init()` lève `WebGPU is not supported in this environment`
quand le navigateur n'a pas de `navigator.gpu`, et `Failed to get GPU adapter`
quand il n'a pas de GPU utilisable. Rabattez-vous sur WebGL2, comme le fait
[Votre première scène](/fdw-engine/fr/getting-started/first-scene/#sous-forme-dapplication).

- Chrome et Edge ont WebGPU sous Windows, macOS et ChromeOS. Sous Linux, il
  peut falloir `chrome://flags/#enable-unsafe-webgpu` et le backend Vulkan
  (`chrome://flags/#enable-vulkan`).
- Firefox l'a dans ses versions récentes sous Windows, et dans Nightly
  ailleurs ; Safari dans ses versions récentes.
- `chrome://gpu` indique si WebGPU est activé, et sinon pourquoi.

Les exemples vivants de ce site font de même : ils indiquent sous le canvas
le backend sur lequel ils tournent. Ajoutez `?backend=webgl2` pour forcer
WebGL2.

### « the backend has no compute shaders »

Un compute graph compilé avec les capacités d'un backend sans calcul
(`capabilities.compute === false`). Les backends du moteur l'ont tous,
WebGL2 par rendu dans des textures : vérifiez les capacités données à
`compile`.

### Rien ne s'affiche

- **Pas de lumière** : `phong` et `pbr` ont besoin de lumières. Sans elles,
  seul `emissive` apparaît. Essayez d'abord `unlit`.
- **La caméra** regarde le long de son axe −z : un objet à l'origine se voit
  depuis `position: { z: 5 }`.
- **Les faces arrière** sont éliminées : les triangles doivent être dans le
  sens antihoraire vus de l'extérieur, ou le matériau `doubleSided`.
- **La taille de la surface** suit les attributs `width` et `height` du
  canvas, pas sa taille CSS : définissez-les, ainsi que l'`aspect` de la
  caméra.
- **Un pipeline encore en compilation**, avec `asyncPipelines: true` :
  l'item est ignoré tant qu'il n'est pas prêt ; `await renderer.whenReady()`.

### Un graphe lève une erreur pendant sa construction

`GraphError` nomme le nœud et le port en cause :

```
error: #n3.b: std.mul: got vec4<f32>, incompatible with vec3<f32> connected to "a"
```

Appliquez un swizzle à la valeur (`.swizzle('rgb')`), ou convertissez-la
(`std.extend`, `std.convert`, `std.vec3`). La seule conversion implicite va
d'un scalaire vers un vecteur.

## Dans l'espace de travail

### « does not provide an export named … »

Le serveur de développement Vite (`demo` ou `docs`) sert une version
périmée d'un paquet dont les exports ont changé. Redémarrez le serveur.

### « The workspace is out of sync »

Les références TypeScript ne correspondent plus aux dépendances des
`package.json` :

```sh
npx nx sync
```

### Une erreur de lint sur un import

`@nx/enforce-module-boundaries` : un projet en importe un autre par un chemin
relatif, ou sans le déclarer. Importez-le par son nom de paquet
(`@fdw/engine-core`), et ajoutez-le aux `dependencies` du `package.json`.

## Natif

### « The native addon of @fdw/engine-native is not built »

```sh
npx nx run engine-native:build-native
```

Il faut CMake 3.24 ou plus récent et un compilateur C/C++20. Le premier build
télécharge SDL3 : il a besoin du réseau.

### « node_api.h not found »

Le build n'a pas trouvé les en-têtes Node-API à côté du Node qui l'exécute :
le binaire `node` qu'utilise Nx est livré sans eux. Installez Node avec ses
en-têtes (nvm, les paquets officiels), ou faites pointer
`NODE_API_INCLUDE_DIR` vers un répertoire contenant `node_api.h`.

### « VULKAN_SDK is not set »

L'addon Vulkan n'est pas construit, et les tests Vulkan sont ignorés.
Installez le [Vulkan SDK](https://vulkan.lunarg.com/sdk/home), puis sourcez
son environnement dans le shell qui construit, teste ou exécute :

```sh
source ~/vulkan/<version>/setup-env.sh
```

### Les shaders ne compilent pas sur Vulkan

Le backend Vulkan charge DXC (`libdxcompiler`) à l'exécution, depuis
`FDW_DXC_LIBRARY`, puis depuis le SDK (`VULKAN_SDK`), puis depuis le système.
Sourcez l'environnement du SDK, ou définissez `FDW_DXC_LIBRARY`.

### La couche de validation ne signale rien

`new VulkanEngine({ validation: true })` n'active la couche que si elle est
installée : `engine.device.validation` indique si elle l'est. Elle est
fournie avec le SDK, et trouvée par `VK_LAYER_PATH`, que définit
`setup-env.sh`.

### La fenêtre native reste noire ou ne s'ouvre pas

- Pas d'affichage : les fenêtres ont besoin de X11 ou de Wayland (`DISPLAY`
  ou `WAYLAND_DISPLAY`).
- Sur Dawn, les images s'affichent avec une ou deux frames de retard, par
  copie : la première image met un instant à venir.
- `--validation` sur la démo native affiche les messages Vulkan à la sortie.
