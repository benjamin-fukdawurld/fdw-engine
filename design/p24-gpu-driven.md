# P24 : les draws indirects et le rendu piloté par le GPU

Le quatrième chantier de la [roadmap revue le 30 octobre 2026](roadmap.md#2-vue-densemble), le premier pas des [évolutions §3](evolutions.md#3-le-rendu-piloté-par-le-gpu) : le GPU choisit lui-même ce qu'il dessine. Il débloque les deux phases sans retard de l'occlusion ([p3 §8](p3-occlusion.md#8-la-suite)), le choix des niveaux de tessellation en calcul ([p3b §8](p3b-tessellation.md#8-la-suite)) et le culling des lumières sur le GPU ([p2-lights](p2-lights.md)).

Contraintes : Vulkan et Direct3D 12 d'abord, WebGPU quand il le peut ; WebGL2 garde son chemin actuel, sans draw indirect ni calcul véritable ; le compilateur de graphs ne change pas (ni atomiques ni mémoire partagée, comme les fluides) ; rien ne change pour qui ne l'active pas ; les mêmes images.

## 1. Aujourd'hui

| Ce qui existe                                                                                                                                           | Ce qui manque                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Le dispatch indirect, sur les trois backends à calcul ; la command signature de Direct3D 12 (constantes racines puis dispatch)                          | Les draws indirects dans l'API abstraite                                         |
| La table des objets (P1) : une ligne stable par objet, la liste des instances de la frame ; l'instance `i` d'un draw lit `instances[firstInstance + i]` | Une liste d'instances écrite par le GPU                                          |
| Le culling du `Renderer` sur le CPU : l'octree de la source, puis l'occlusion relue avec une à trois frames de retard (P3)                              | Un test par instance sur le GPU, dont le résultat est dessiné dans la même frame |
| Des graphs de calcul sans atomiques : la compaction par tri bitonique des fluides (P21)                                                                 | Une compaction des instances visibles                                            |

## 2. Les options

| Option                                                                                                                                                            | Pour                                                                                                                                   | Contre                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Un draw indirect par lot du CPU** : les lots (mesh, matériau, pipeline) restent ceux du CPU ; le GPU filtre les instances de chaque lot et écrit leur nombre | Rien ne change dans les matériaux, les bind groups, les pipelines ; un draw par lot comme aujourd'hui ; l'ordre des transparents gardé | Le CPU parcourt encore les objets candidats (l'octree, la préparation) ; le gain est le test sur le GPU, pas encore le coût par objet du CPU |
| B. Les tables de la scène : toutes les instances sur le GPU, un `multiDrawIndirect` par pipeline, les meshes dans un grand buffer                                 | Le CPU ne touche plus les objets                                                                                                       | Un allocateur de meshes, des matériaux sans changement d'état (bindless), `multiDrawIndirect` et `drawIndirectCount` : très grand            |
| C. Mesh shaders, meshlets                                                                                                                                         | Le culling par meshlet                                                                                                                 | Ni WebGPU ni WebGL2, un second chemin de géométrie                                                                                           |

**Choix : A maintenant**, qui pose les draws indirects et la compaction dont B et l'occlusion sans retard ont besoin. B reste la suite (§8), pour les maquettes CAO de centaines de milliers d'objets.

## 3. Le mécanisme

### 3.1 Les draws indirects

`drawIndirect(buffer, offset)` et `drawIndexedIndirect(buffer, offset)` sur `GpuRenderPassEncoder`, aux arguments de WebGPU (et de Vulkan) :

| Draw                  | Mots (u32)                                                         |
| --------------------- | ------------------------------------------------------------------ |
| `drawIndirect`        | `vertexCount, instanceCount, firstVertex, firstInstance`           |
| `drawIndexedIndirect` | `indexCount, instanceCount, firstIndex, baseVertex, firstInstance` |

Le buffer a l'usage `indirect`. La capacité `indirectDraw` les annonce :

- **Vulkan** : `vkCmdDrawIndirect` / `vkCmdDrawIndexedIndirect`, avec la feature `drawIndirectFirstInstance` (la table des objets en dépend) ; la barrière du buffer (`DRAW_INDIRECT`, `INDIRECT_COMMAND_READ`) rejoint celles de la passe, placées avant elle.
- **Direct3D 12** : `SV_InstanceID` part de 0, la première instance vient d'une constante racine. Comme pour le dispatch indirect, une command signature par root signature (une constante, puis le draw) ; les arguments recopiés dans le buffer de travail de la soumission, la première instance devant le draw (`CopyBufferRegion`), avant la passe : une passe de rendu ne peut pas copier.
- **WebGPU** : avec la feature `indirect-first-instance` seulement (sans elle, un `firstInstance` non nul saute le draw).
- **WebGL2** : refusé, comme le dispatch indirect.

### 3.2 La compaction sans atomiques

Une vue d'une passe de scène avec `gpuCulling` : le CPU fait ses lots comme aujourd'hui (les entrées triées, les suites d'un même mesh, matériau et pipeline), mais n'écrit plus les instances. Il envoie les **candidats** (une ligne de la table et ses bornes dans le monde par instance, dans l'ordre des lots), réserve leur place dans la liste des instances, et une passe de calcul :

1. **Le test** (un thread par candidat) : la boîte contre les six plans du frustum, `visible[i] ∈ {0, 1}`. Une instance sans bornes est visible.
2. **Le préfixe** (Hillis et Steele, ⌈log₂ n⌉ dispatches en ping-pong) : `scan[i] = visible[0] + … + visible[i]`.
3. **L'écriture** (un thread par candidat) : un candidat visible va à `instances[first + scan[i] − 1]`. La compaction est globale, donc **stable** : les instances d'un lot restent contiguës et dans leur ordre (les transparents gardent leur tri).
4. **Les arguments** (un thread par lot `[début, fin)`) : `instanceCount = scan[fin − 1] − scan[début − 1]`, `firstInstance = first + scan[début − 1]` ; le nombre d'indices (ou de sommets) donné par le CPU.

Puis un `drawIndexedIndirect` par lot, à l'offset de ses arguments. Un lot vide coûte un draw de zéro instance.

Le préfixe en ⌈log₂ n⌉ dispatches coûte O(n log n) : 17 passes pour 100 000 candidats, négligeable devant le rendu ; une version en mémoire partagée (un dispatch par niveau de blocs) attendra les atomiques et la mémoire partagée du compilateur.

### 3.3 La table des objets

La liste des instances est écrite par le GPU : `GpuObjectTable.instanceBuffer`, le storage buffer des instances (Vulkan, Direct3D 12, WebGPU). La table peut grandir pendant la frame (une autre passe ajoute des instances) : la passe dessinée lie alors la table que le calcul a écrite, gardée jusqu'à la frame suivante comme aujourd'hui.

## 4. L'API

```ts
renderer.addScenePasses(graph, {
  source: scene,
  camera,
  target,
  gpuCulling: true, // where the backend has indirectDraw and compute
});
```

Sans la capacité (WebGL2), `gpuCulling` est ignoré : le chemin du CPU. Les statistiques de la vue (`drawn`) comptent alors les candidats, pas ce que le GPU garde.

## 5. Ce qu'il a fallu ajouter au moteur

- `GpuRenderPassEncoder.drawIndirect` / `drawIndexedIndirect`, la capacité `indirectDraw`, sur Vulkan, Direct3D 12 et WebGPU ; les commandes `FDW_VK_CMD_DRAW_INDIRECT` et `FDW_VK_CMD_DRAW_INDEXED_INDIRECT` des deux bibliothèques natives.
- `GpuObjectTable.instanceBuffer`.
- `engine-core/src/render/gpuCulling.ts` : les quatre graphs de calcul et leur passe.

## 6. Mesures

À faire avec l'étape 3 : le temps GPU de la passe de culling (timestamps) pour 10 000 et 100 000 candidats, sur la ville de P3.

## 7. Tests

- **Rendu, sur les backends à draws indirects** (Vulkan avec la couche de validation, Direct3D 12, Dawn) : la compaction de cinq candidats en deux lots (dedans, dehors, à cheval sur un plan, sans bornes), les instances et les arguments relus ; WebGL2 n'a pas la capacité.
- **La même image** avec et sans `gpuCulling`, sur les quatre backends, deux frames de suite : des objets hors du frustum, instanciés, un mesh sans indices (`drawIndirect`), des transparents, un lot sans instance visible.
- **CPU** (`Renderer.spec`) : les dispatches de la passe de culling, les draws indirects sans instances écrites par le CPU, le repli sans la capacité.

## 8. Les étapes

| Étape                           | Contenu                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Les draws indirects**      | L'API, les trois backends, le refus de WebGL2, les tests de rendu                                                                                |
| **2. Le culling des instances** | La compaction (§3.2), `gpuCulling` dans les passes de scène, `instanceBuffer`                                                                    |
| 3. L'occlusion sans retard      | Les deux phases de P3 : la visibilité de la frame précédente par ligne sur le GPU, la pyramide, le test du reste contre elle dans le même calcul |
| 4. La tessellation en calcul    | Les niveaux des patchs de P3b choisis par un calcul, le nombre de patchs par draw indirect                                                       |
| 5. Les lumières                 | Le remplissage des clusters de P2 en calcul                                                                                                      |
| 6. Les tables de la scène       | L'option B (§2) : les instances persistantes, un allocateur de meshes, `multiDrawIndirect` et `drawIndirectCount`                                |

## 9. Décisions

- **Un draw par lot du CPU** plutôt que les tables de la scène : les draws indirects et la compaction d'abord, sans toucher aux matériaux.
- **Le préfixe en plusieurs dispatches** plutôt que des atomiques : le compilateur reste le même sur les quatre backends, et la compaction est stable.
- **WebGPU compris** quand il a `indirect-first-instance` : le même code que Vulkan, testé sur Dawn.

## 10. État

_Étapes 1 et 2 faites (4 novembre 2026)_ : `drawIndirect` et `drawIndexedIndirect` sur Vulkan, Direct3D 12 et WebGPU (`indirect-first-instance`), la capacité `indirectDraw` ; la compaction sans atomiques (`engine-core/src/render/gpuCulling.ts`) ; l'option `gpuCulling` des passes de scène ; `GpuObjectTable.instanceBuffer` ; le guide des backends (EN, FR). Reste : les mesures (§6) et les étapes 3 à 6.
