---
title: Introduction
description: Ce qu'est FdwEngine, ce qu'il fait, et comment cette documentation est organisée.
sidebar:
  order: 1
---

FdwEngine est un moteur 3D écrit en TypeScript. Le même code applicatif
s'affiche dans le navigateur, avec **WebGPU** ou **WebGL2**, et dans une
fenêtre native, avec **WebGPU (Dawn)** ou **Vulkan 1.3**. Les scènes, les
matériaux et les passes de rendu sont écrits une seule fois ; seul le choix du
backend dépend de la plateforme.

:::caution[En cours de développement]
Le moteur est jeune et ses API évoluent encore. Il n'est pas encore publié sur
npm : les applications sont construites dans le monorepo (voir
[Installation](/fdw-engine/fr/getting-started/installation/)).
:::

## Ce qu'il fait

- **Des matériaux sous forme de graphes.** Un matériau est un graphe de nœuds
  typés, vérifié au fur et à mesure de sa construction, compilé en WGSL,
  GLSL ES ou HLSL pour chaque backend. Ses valeurs (couleurs, textures)
  changent sans rien recompiler ; ses paramètres statiques sélectionnent des
  variantes du programme.
- **Modèles d'ombrage.** Unlit, Phong et PBR (metallic/roughness, comme dans
  glTF) sont fournis avec le moteur. Un modèle personnalisé est lui aussi un
  graphe.
- **Éclairage et ombres.** Lumières directionnelles, ponctuelles et spots ;
  shadow maps pour les lumières directionnelles et les spots, dans un atlas,
  filtrées (PCF).
- **Couleurs et HDR.** Couleurs linéaires, textures sRGB, une cible HDR avec
  tone mapping (Reinhard, ACES, Khronos PBR Neutral), multisampling.
- **Render graph.** Une image est un graphe de passes qui déclarent ce
  qu'elles lisent et écrivent : le moteur les ordonne, élimine celles qui ne
  servent pas, alloue et réutilise leurs textures, et insère les barrières
  sous Vulkan. Les effets de post-traitement sont des matériaux dessinés
  par-dessus l'écran.
- **Compute.** Les graphes de calcul, écrits avec les mêmes nœuds, s'exécutent
  sur le GPU et écrivent dans des storage buffers (WebGPU, Vulkan).
- **Natif.** Des fenêtres (SDL3) et une boucle de rendu pour Node, qui
  présentent les images WebGPU produites par Dawn, ou les images Vulkan via
  une swapchain.

## Les couches

```
Application
    │
@fdw/engine-core      Scene objects, materials, Renderer, render graph
    │
@fdw/engine-backend   The abstract API: engine, surface, GPU resources, commands
    │
@fdw/engine-webgpu · @fdw/engine-webgl2 · @fdw/engine-vulkan
```

`@fdw/engine-shader`, le material graph et son compilateur, est utilisé par
toutes les couches et ne dépend d'aucune : c'est du TypeScript pur.
`@fdw/engine-native` fournit les fenêtres et les surfaces natives.

Une application s'adresse à `@fdw/engine-core` et `@fdw/engine-shader`, et
choisit un backend une seule fois, au démarrage. La page
[Architecture](/fdw-engine/fr/contributing/architecture/) entre dans les détails.

## Cette documentation

- **Premiers pas** : installer l'espace de travail, afficher une première
  scène, l'exécuter dans une fenêtre native.
- **Tutoriels** : une fonctionnalité à la fois, chacune avec un exemple
  interactif. Le code affiché sous un exemple est celui qui l'exécute.
- **Guides** : le fonctionnement de chaque partie du moteur, et ses options.
- **Contribuer** : l'espace de travail, les conventions, les tests, et comment
  étendre le moteur.
- **Référence de l'API** : générée à partir des commentaires des sources.

Les exemples interactifs utilisent WebGPU si votre navigateur le prend en
charge, WebGL2 sinon. Ajoutez `?backend=webgl2` à l'adresse d'une page pour
forcer WebGL2.
