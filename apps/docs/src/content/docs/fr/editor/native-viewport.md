---
title: Le viewport natif
description: "Comment l'éditeur de bureau montre le moteur dans sa fenêtre, sur Vulkan et sans copie, comment les entrées lui parviennent, et ce que cela coûte."
sidebar:
  order: 4
---

L'éditeur de bureau est une application Electron, mais sa vue 3D n'est
pas un `<canvas>` de la page : le moteur la rend en natif, sur Vulkan,
dans une fenêtre à lui placée au-dessus de la zone du viewport. Cette page
explique comment, pour qui travaille sur l'éditeur ou écrit un autre
hôte.

## Les processus

```
page (React)  ── MessagePort ──►  processus du moteur (utility process d'Electron)
  RemoteViewport : les bornes,       EditorEngine, les scènes, le niveau
  les entrées, les trous             une swapchain Vulkan sur la fenêtre enfant
        ▲                            fdw_editor.node : la fenêtre X11 enfant
        │ un port à chaque chargement de la page
processus principal : le XID de la fenêtre, les dialogues, le stockage
```

- **Le moteur tourne dans un processus utilitaire** d'Electron : il ne
  bloque jamais l'interface, et l'interface n'attend jamais une image. Le
  processus principal le démarre et lui donne l'identifiant de la fenêtre
  (son XID) ; puis, à chaque chargement de la page, un `MessagePort` vers
  la page. Le processus principal reste hors des images.
- **La fenêtre du viewport** est une fenêtre X11 enfant de la fenêtre
  d'Electron, créée par l'addon de l'éditeur (`apps/editor/native`). Le
  moteur y présente avec sa propre swapchain (`@fdw/engine-vulkan`,
  FIFO) : les pixels vont du GPU à l'écran sans passer par le CPU, ni par
  Chromium.
- **La page** réserve la zone, la mesure à chaque frame d'animation, et
  envoie ses bornes en pixels physiques au moteur, qui place et
  dimensionne la fenêtre, et recrée la swapchain quand la taille change.
  Une zone derrière un autre onglet est vide : pas d'images. Pas non plus
  tant que la fenêtre est réduite ou cachée.

## Les entrées

La fenêtre du viewport a une **région d'entrée vide** (l'extension Shape
de X11) : la souris et le clavier la traversent jusqu'à l'élément de la
page en dessous. La page les y lit avec une `WebInputSource`, comme sur un
canvas, et envoie les appels au moteur, qui les rejoue
(`RemoteInputSource`) : les scènes lisent le même `Input` que dans un
navigateur. Le focus reste à la page, le pointeur se verrouille sur son
élément, un glissé est capturé par lui, les manettes sont lues par la page
à chaque frame.

## La page au-dessus du viewport

Rien de la page ne peut être dessiné au-dessus de la fenêtre du viewport.
Les menus, la palette de commandes, les groupes flottants de panneaux qui
la croisent sont envoyés au moteur comme des **trous**, des rectangles que
l'addon découpe de la fenêtre (sa région de forme) : la page se voit à
travers. Chromium recrée ses propres fenêtres quand la fenêtre est
redimensionnée ; le viewport les surveille, et reste au-dessus.

## Le backend et son repli

Sur Vulkan, le chemin est celui ci-dessus, sans copie. Quand Vulkan ne
démarre pas (`FDW_BACKEND=dawn`, pas de périphérique, pas d'addon), le
moteur tourne sur Dawn, dans un processus Node à lui : Dawn n'y présente
pas dans une fenêtre, chaque image est donc relue, et copiée dans la
fenêtre par l'addon (MIT-SHM). Un repli qui marche, pas le chemin normal.

## Ce que cela coûte

Mesuré sous Linux (X11, GNOME), une RTX 2060 SUPER à 60 Hz, le viewport
en 1280 × 720, par `apps/editor/scripts/measure.mjs` : le CPU de chaque
processus en pourcentage d'un cœur (médiane de trois mesures de 10
secondes), et la même scène dans une fenêtre de `demo-native`, sans
l'éditeur autour.

| Cas                                    | Images/s | CPU du moteur | CPU de l'interface¹ | GPU d'une image² |
| -------------------------------------- | -------- | ------------- | ------------------- | ---------------- |
| Éditeur, le niveau, Vulkan             | 60       | 7,9 %         | 5,5 %               | 0,20 ms          |
| Éditeur, le niveau, palette par-dessus | 60       | 8,8 %         | 6,1 %               | 0,17 ms          |
| Éditeur, le niveau, Dawn               | 61       | 21,7 %        | 5,5 %               | 0,16 ms          |
| Éditeur, `shadows`, Vulkan             | 60       | 7,8 %         | 5,1 %               |                  |
| `demo-native`, `shadows`, Vulkan       | 61       | 7,3 %         |                     |                  |
| Éditeur, `tps`, Vulkan                 | 60       | 75 %          | 5,7 %               |                  |
| `demo-native`, `tps`, Vulkan           | 60       | 85 %          |                     |                  |

¹ Le processus principal, la page et le processus GPU de Chromium. ² Les
passes du niveau, mesurées par des timestamps GPU (la status bar les
montre).

- **Le moteur coûte dans l'éditeur ce qu'il coûte seul** : la même scène
  prend le même CPU dans l'éditeur que dans une fenêtre à elle.
- **L'interface coûte 5 à 6 % d'un cœur**, sans rien qui bouge : la page
  lit les bornes du viewport et les trous à chaque frame d'animation.
- **Les trous ne coûtent rien de mesurable** : une palette au-dessus du
  viewport garde 60 images par seconde.
- **Le repli sur Dawn coûte 14 % d'un cœur de plus**, pour la relecture et
  la copie de chaque image.

```sh
npx nx run editor:build
node apps/editor/scripts/measure.mjs --out measures.json
```

## Les autres systèmes

Le même contrat, une surface native placée dans la zone de la page et
transparente aux entrées, est prévu sur les autres systèmes : une fenêtre
`WS_CHILD` sous Windows, une `NSView` avec une `CAMetalLayer` sous macOS,
une sous-surface sous Wayland (Electron tourne sur XWayland en
attendant). Ils viennent avec la distribution de l'éditeur.
