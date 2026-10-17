# Asset tools

Prepare third-party models for the demos and the documentation: compact
`.glb` files in `apps/docs/public/models/forest/` (versioned with Git LFS),
from sources kept out of the repository.

| Tool                  | Writes                                                    | From (CC0)                                                                                                                         |
| --------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `make-forest.mjs`     | `fir.glb`, `fern.glb`, `grass.glb`, `forest_ground_*.jpg` | Poly Haven: Fir Tree 01, Fern 02, Grass Medium 01, Forest Ground 04 (glTF, 1k)                                                     |
| `make-characters.mjs` | `hero.glb`, `orc.glb`, `demon.glb`                        | Quaternius: Modular Character Outfits – Fantasy, Universal Animation Library 1 and 2, Ultimate Monsters; Poly Haven: Antique Estoc |

Download the sources, as they come, into one directory (the repository
root by default), then:

```sh
node tools/assets/make-forest.mjs [--from <directory>] [--only fir,fern,grass,ground]
node tools/assets/make-characters.mjs [--from <directory>] [--only hero,orc,demon]
node --import jiti/register tools/assets/preview.ts apps/docs/public/models/forest/hero.glb --clip SwordIdle --time 0.5
```

- `gltf.mjs` reads and writes glTF (accessors as typed arrays, images
  embedded), `mesh.mjs` simplifies (meshoptimizer) and compacts
  primitives, `foliage.mjs` turns geometry foliage into textured cards.
- `preview.ts` renders a model to a PNG with Dawn, in Node, posed by a
  clip if asked.

The levels of the fir, the cards of its needles, the clips copied by the
names of the joints and the grip of the sword are explained in the
documentation: tutorial « Levels of detail », page « A third-person game ».
