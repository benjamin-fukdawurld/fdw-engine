---
title: The game
description: A small game built step by step on the engine, in the browser and in a native window.
sidebar:
  order: 1
---

This tutorial builds a small game, one step at a time: a **maze seen from
above**, explored by a character carrying a **flashlight**, in the dark —
only what the flashlight lights is visible. Each step is playable, and adds
a part of the engine:

| Step                                              | Contents                                                                                               | Engine                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [1. The maze](/fdw-engine/game/maze/)             | A generated maze of thousands of nodes, a camera flying over it, a top view of what the camera retains | Scenes, static nodes, culling, render graph         |
| [2. The character](/fdw-engine/game/character/)   | A character moved with the keyboard, colliding with the walls, followed by the camera                  | Nodes, hierarchy, queries with volumes              |
| [3. The flashlight](/fdw-engine/game/flashlight/) | A spot carried by the character, aimed with the mouse, in the dark                                     | Lights and shadows limited to the view              |
| [4. The game](/fdw-engine/game/the-game/)         | Gems to collect, enemies wandering, lines of sight, a map revealed by exploration                      | The ECS core and its systems, rays, texture updates |

## Where the code is

The code of the game is in `packages/demo-scenes/src/maze/`, shared by:

- the browser demo: `npx nx serve demo`, then the **Maze** route;
- the native demo: `npx nx run demo-native:start -- maze` (WebGPU on Dawn,
  or `--vulkan`), `-- maze-1` to `-- maze-3` for the first steps;
- the pages of this tutorial, where each step runs live.

A step is a `SceneFactory`: a function receiving the backend, the surface,
and a context — where the keyboard and mouse events come from, and where to
show a line of information — and returning a `frame(time)` function. The
same function runs in a page, in the demo and in a native window: the
events of a native window are DOM events too.

```ts
export const createMazeStep1: SceneFactory = (
  backend,
  surface,
  context = {}
) => {
  // … build the game …
  return {
    frame: (time) => {
      /* … update, then render … */
    },
    destroy: () => {
      /* … */
    },
  };
};
```

## Before starting

The tutorials of this site, especially [A scene](/fdw-engine/tutorials/scene/),
introduce what the game uses: nodes, static nodes, the renderer drawing a
scene.
