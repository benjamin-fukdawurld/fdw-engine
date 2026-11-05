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

### 3.4 L'occlusion en deux phases (étape 3)

Avec `gpuCulling` et un `OcclusionCulling` (qui a `addPyramid`), les passes de scène ne demandent plus rien au culler sur le CPU (`visible` n'est pas appelé, rien n'est relu) :

1. **La première phase** (`scene culling`) : le test du frustum et de l'**historique**, un u32 par ligne de la table des objets (`GpuCulling.history`, par vue), 1 si l'objet était visible à la frame précédente ; la compaction et les arguments comme au §3.2 ; la passe `scene opaque` les dessine.
2. **La pyramide** : les passes plein écran de P3 (`OcclusionCuller.addPyramid`), sur la profondeur de la première phase.
3. **La seconde phase** (`scene occlusion culling`), dans une passe de calcul : le test du frustum et de la pyramide (`boxVisibility` d'`engine-occlusion`, le même que le fragment de P3, ajouté au graphe de calcul : les niveaux lus par `textureLoad`) ; l'historique réécrit pour toutes les lignes ; dessinés ceux qui sont visibles et que la première phase n'a pas dessinés (`drawn`, sa visibilité par candidat, gardée hors du préfixe). Les transparents sont testés dans la même passe, contre la même pyramide, sans historique. La passe `scene opaque late` charge la couleur, les sorties et la profondeur, et dessine.

La seconde phase réutilise les boîtes et les lignes de la première (les mêmes candidats, dans le même ordre) et n'ajoute que ses instances (`ObjectRows.extend`). Un historique trop petit (de nouvelles lignes) est remplacé par un historique vide : ces objets sont dessinés par la seconde phase s'ils sont visibles. L'historique ne sert qu'à la performance : l'image ne dépend pas de lui.

Ce qui est caché par la première phase seule l'est par l'image finale : le test est conservateur. Ce que le mouvement découvre est dessiné dans la frame où il apparaît. Sans MSAA, comme P3 ; les passes des transparents seules (`include: 'transparent'`) ne sont cullées que par le frustum.

### 3.5 Les clusters de lumières (étape 5)

La grille de P2 (deux u32 par cluster, puis les listes) remplie par cinq graphes, sans atomiques :

1. **Les tuiles** (un fil par lumière et par tranche) : la part de la sphère englobante dans la tranche, sa boîte projetée, les tuiles couvertes, comme `LightClusters.assign` ; agrandie d'un epsilon (les f32) : une lumière peut être listée dans un cluster de plus, où elle donne moins que `LightThreshold`, jamais l'inverse.
2. **Les paires** (un fil par cluster et par lumière, cluster d'abord) : 1 si la lumière couvre la tuile du cluster dans sa tranche.
3. **Le préfixe** des paires, comme au §3.2.
4. **Les listes** : la lumière de chaque paire trouvée, à son rang, après les en-têtes. Les paires étant rangées par cluster puis par lumière, les listes sont celles du CPU, dans le même ordre.
5. **Les en-têtes** : le premier élément et la longueur de chaque liste.

Le CPU n'écrit que les sphères (O(lumières)). Les paires sont dispatchées le long de x (65 535 workgroups) : 1024 lumières bornées au plus dans le champ (`MaxGpuClusterLights`), le CPU au-delà. La grille est importée dans le graphe : écrite par la passe `scene light clusters`, lue par les passes de scène.

### 3.6 Les niveaux de tessellation (étape 4)

`PatchSurface` avec `levels: 'gpu'` : le choix de `LevelSelection` et le rangement de `writeDraws` en cinq graphes, dans une soumission à `update` :

1. **Les arêtes** (un fil par arête) : le niveau par la longueur à l'écran vue du point le plus proche, comme sur le CPU.
2. **Les drapeaux** (un fil par niveau et par patch, niveau d'abord) : 1 si le patch est dans le champ et à ce niveau.
3. **Le préfixe** : le rang de chaque patch dessiné, rangé par niveau.
4. **Les débuts** (un fil) : les patchs de chaque niveau ; le niveau le plus fin qui garde les sommets sous 2^24 (le CPU baisse `maxLevel` jusqu'à ce qu'ils y tiennent ; ici, le nombre plafonné à `k` se déduit des nombres non plafonnés) ; le premier sommet et le premier tracé de chaque niveau ; le nombre de sommets.
5. **Les tracés** (un fil par niveau et par patch) : chaque patch à son rang, avec les pas de ses arêtes, plafonnés.

Le shader des patchs lit désormais les tracés et les débuts dans un **storage buffer** (`PatchValues.draws` : quatre vec4f d'en-tête, puis un par patch), sur les deux chemins et sur tous les backends (WebGL2 les double d'une texture de données) : un seul graphe, la texture des tracés et les uniforms des débuts disparaissent.

Le nombre de sommets du draw : `Mesh.setGpuVertexCount({ buffer, offset })`. Le `Renderer` ne connaît la première instance de l'objet qu'à l'exécution de la passe : une **passe de copie** (`scene vertex counts`), avant les passes qui dessinent, recopie le nombre dans les arguments du draw (ceux du culling sur le GPU, ou un emplacement du `Renderer` dont le CPU écrit les autres mots au draw). Même mécanisme pour les ombres.

### 3.7 Les tables de la scène (étape 6)

Une première part de l'option B (§2), sans changer les matériaux :

- **Les draws multiples** : `multiDrawIndirect` et `multiDrawIndexedIndirect` (draws à 20 octets d'intervalle, avec un nombre lu par le GPU en option) ; capacités `multiDrawIndirect` et `drawIndirectCount`. Vulkan : `vkCmdDraw(Indexed)Indirect(Count)` avec les features `multiDrawIndirect` et `drawIndirectCount` (1.2). Direct3D 12 : un `ExecuteIndirect` de `maxCount` commandes, chacune précédée de sa première instance (recopiées dans le buffer de travail, 2048 au plus), le nombre lu dans son buffer. WebGPU : un draw indirect chacun, sans nombre.
- **L'allocateur de meshes** : `MeshArena` ; les meshes d'une arène de même format placés dans des buffers partagés (`ArenaBuffers` : premier emplacement libre, `RangeAllocator`, fusion des voisins libérés ; les buffers doublent, leur contenu recopié par le GPU, les anciens retirés à la frame suivante). Ils sont toujours dessinés en indirect : `firstIndex` et `baseVertex` dans les arguments (ceux du culling, ou écrits par le CPU dans un emplacement). Ailleurs (WebGL2), une arène ne change rien.
- **Les groupes** : cullés sur le GPU, les lots consécutifs d'une même arène, pipeline, programme, vue et matériau deviennent un draw multiple (1024 au plus). Avec `drawIndirectCount`, deux graphes de plus tassent les draws non vides de chaque groupe au début de sa plage et écrivent leur nombre (`culling non-empty runs`, le préfixe des lots, `culling pack`).

Reste de B (§8) : les instances persistantes sur le GPU (§3.8), les matériaux sans changement d'état.

### 3.8 La scène gardée sur le GPU (étape 7)

Les mesures (§6) le montrent : avec le culling sur le GPU, le coût du CPU est la préparation de chaque candidat (la requête de l'octree, `prepare`, le tri, les lots, les lignes, les boîtes). Une `GpuScene` garde ses objets sur le GPU d'une frame à l'autre :

- **Les données persistantes** (`GpuSceneLayout`, une par renderer et par scène) : les boîtes (centre, demi-étendues) et les lignes des objets opaques, rangées par lot (un par mesh et matériau, les lots d'un matériau à la suite), dans deux storage buffers. Rangées à nouveau quand des objets sont ajoutés ou retirés ; sinon seuls les objets touchés (`touch`) et dynamiques (`dynamic: true`) sont réécrits, 32 et 4 octets chacun. Leurs lignes dans la table des objets sont mises à jour par `ObjectRows.rowOf`, écrites avec les autres.
- **Le culling** : `GpuCulling.record` reçoit les candidats déjà sur le GPU (`persistent`) ; rien n'est envoyé, les instances seules sont réservées (`ObjectRows.extend`). Les deux phases de l'occlusion s'appliquent (la seconde reprend les buffers de la première).
- **Les lots** : préparés une fois par frame (un `prepare` par lot, avec le premier objet), dessinés par un draw indirect chacun, ou par un draw multiple pour les meshes d'une arène.
- **Ce qui reste sur le CPU** : les objets transparents (triés à chaque frame : la source de la scène les donne à la caméra), les projeteurs d'ombres (la même source les donne aux shadow maps, testés un à un).

Sans culling sur le GPU (WebGL2), la scène est une liste d'objets. Les layers des vues ne s'appliquent pas à elle ; une scène est dessinée par un seul renderer (`takeTouched` consomme les changements).

Reste de B : les matériaux sans changement d'état (bindless), qui feraient un draw multiple par pipeline. WebGPU n'a pas de bindless, et le compilateur devrait lire les valeurs des matériaux dans une table par instance : un chantier à part, pour quand les changements d'état domineront.

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

```ts
// L'occlusion en deux phases : le même OcclusionCulling.
renderer.render({ source, camera, surface, occlusion, gpuCulling: true });
// Les clusters de lumières : rien à ajouter, gpuCulling suffit.
// La tessellation :
new PatchSurface(backend, { patches, material, levels: 'gpu' });
// Les meshes partagés :
const arena = new MeshArena({ label: 'buildings' });
new Mesh({ description, vertices, indices, arena });
// Les draws multiples :
pass.multiDrawIndexedIndirect(buffer, offset, maxCount, {
  buffer: counts,
  offset: 0,
});
```

## 5. Ce qu'il a fallu ajouter au moteur

- `GpuRenderPassEncoder.drawIndirect` / `drawIndexedIndirect`, la capacité `indirectDraw`, sur Vulkan, Direct3D 12 et WebGPU ; les commandes `FDW_VK_CMD_DRAW_INDIRECT` et `FDW_VK_CMD_DRAW_INDEXED_INDIRECT` des deux bibliothèques natives.
- `GpuObjectTable.instanceBuffer`.
- `engine-core/src/render/gpuCulling.ts` : les quatre graphs de calcul et leur passe.
- Étape 3 : `OcclusionCuller.addPyramid` et `OcclusionPyramid` ; `boxVisibility` d'`engine-occlusion` ; les phases de `GpuCulling` (`CullingPhase`, `history`) ; `ObjectRows.extend`.
- Étape 5 : `engine-core/src/render/gpuLightClusters.ts` (`GpuLightClusters`, `MaxGpuClusterLights`) ; `lightSpheres`, `sliceParameters`.
- Étape 4 : `engine-tessellation/src/gpuLevels.ts` (`GpuLevels`) ; `Mesh.setGpuVertexCount` ; le storage buffer des tracés.
- Étape 7 : `GpuScene` (`add`, `remove`, `touch`, `dynamic`), l'option `gpuScene` des passes de scène, `GpuSceneLayout`, `CullingCandidates.persistent` et `count`, `ObjectRows.rowOf`.
- Étape 6 : `multiDrawIndirect`, `multiDrawIndexedIndirect`, `IndirectCount`, les capacités ; les commandes `FDW_*_CMD_MULTI_DRAW_INDIRECT` et `FDW_*_CMD_MULTI_DRAW_INDEXED_INDIRECT` des deux bibliothèques natives ; `MeshArena`, `RangeAllocator`, `ArenaBuffers`.
- Les briques communes de la compaction exportées (`computeGraph`, `scanGraph`, `recordPrefixSum`) ; `log.bufferCopies` du faux backend.

## 6. Mesures

`tools/bench/gpu-driven.ts` : la ville de P3 agrandie (blocs de 3 × 3 immeubles : 33² blocs, 9801 immeubles ; 105² blocs, 99 225), vue de l'avenue, 1920 × 1080, sans ombres, Vulkan sans couche de validation, RTX 5070 Ti Laptop ; les temps GPU par timestamps (`RenderGraphRunner({ timing: true })`), médianes de 40 frames.

|                                    | 9801, CPU (P3) | 9801, GPU (deux phases) | 99 225, CPU (P3) | 99 225, GPU (deux phases) |
| ---------------------------------- | -------------- | ----------------------- | ---------------- | ------------------------- |
| Candidats (dans le frustum)        | 5617           | 5617                    | 48 740           | 48 740                    |
| Donnés aux passes                  | 430            | 5617                    | 1557             | 48 740                    |
| GPU, culling (`scene culling`)     | —              | 0,037 ms                | —                | 0,044 ms                  |
| GPU, seconde phase (avec son test) | 0,008 ms       | 0,038 ms                | 0,010 ms         | 0,046 ms                  |
| GPU, toutes les passes             | 0,17 ms        | 0,25 ms                 | 0,17 ms          | 0,26 ms                   |
| CPU par frame                      | 3,9 ms         | 11,9 ms                 | 25,6 ms          | 67 ms                     |

(Le « test » du CPU est la passe plein écran de P3 ; sa relecture arrive une à trois frames plus tard.)

Avec l'étape 7, la même mesure (le même script, mode `gpu scene` : tous les objets de la ville dans une `GpuScene`, 10 891 et 110 251 candidats avec les rues), médianes de 40 frames :

|                                | 9801, GPU (deux phases) | 9801, `GpuScene` | 99 225, GPU (deux phases) | 99 225, `GpuScene` |
| ------------------------------ | ----------------------- | ---------------- | ------------------------- | ------------------ |
| CPU par frame                  | 5,9 ms                  | **1,3 ms**       | 125 ms                    | **1,0 ms**         |
| GPU, culling (`scene culling`) | 0,036 ms                | 0,038 ms         | 0,045 ms                  | 0,084 ms           |
| GPU, seconde phase             | 0,036 ms                | 0,039 ms         | 0,047 ms                  | 0,088 ms           |
| GPU, toutes les passes         | 0,23 ms                 | 0,22 ms          | 0,26 ms                   | 0,59 ms            |

Le CPU ne dépend plus du nombre d'objets : un lot par mesh et matériau. Le GPU teste tous les objets (pas seulement ceux du frustum de l'octree) : le culling double à 110 000 candidats, toujours sous 0,1 ms par phase. Les temps du CPU de ce poste varient d'une exécution à l'autre (de 67 à 160 ms pour le chemin GPU sans scène à 99 225) ; leur ordre de grandeur est stable.

Ce que disent ces mesures :

- **Le GPU** : le culling coûte 0,04 ms par phase, presque le même pour 5617 et 48 740 candidats (17 dispatches de préfixe, des fils très courts) : les coûts fixes des dispatches dominent. La version en mémoire partagée (§3.2) n'est pas nécessaire.
- **Le CPU** : l'option A prépare encore chaque candidat (requête de l'octree, préparation, tri, lots, lignes, boîtes). L'occlusion par relecture écarte les objets cachés avant leur préparation : avec beaucoup d'objets cachés, elle reste moins chère sur le CPU (3,9 contre 11,9 ms ; 25,6 contre 67 ms). Le profil du chemin GPU à 99 225 : la requête de l'octree, `prepare`, le tri, `ObjectRows.reserve`, l'écriture des boîtes, à parts comparables. Le gain des deux phases est l'image sans retard ; celui du CPU viendra des instances persistantes (§8), qui retirent la préparation par objet.
- Les autres passes ne changent pas (`scene opaque` à 0,12–0,13 ms : la ville dessine des cubes).

## 7. Tests

Étapes 3 à 6 :

- **Rendu, Vulkan (validation), Direct3D 12, Dawn** : les deux phases (un quad caché sans test de profondeur montre ce qui est dessiné : tout à la première frame, retiré à la troisième, de nouveau là dans la frame même où le mur s'en va) ; la grille des clusters du GPU contre celle du CPU (150 lumières, ponctuelles et spots : les listes du CPU dans celles du GPU, dans le même ordre, moins de 2 % d'ajouts) et la même image avec et sans `gpuCulling` (300 lumières) ; les niveaux de tessellation du GPU (la même image, le même nombre de sommets que le CPU) ; 1100 meshes d'une arène (croissance des buffers, deux groupes, des lots vides) contre les mêmes hors arène, avec et sans `gpuCulling`. WebGL2 : la tessellation par le storage buffer, le repli sans capacité.
- **CPU** (faux backend) : les passes et les dispatches des deux phases, l'arrêt des appels `visible` ; les dispatches des clusters ; les dispatches des niveaux, la copie du nombre de sommets et le draw indirect ; l'allocateur, les buffers partagés, le draw multiple avec et sans nombre lu par le GPU.

Étapes 1 et 2 :

- **Rendu, sur les backends à draws indirects** (Vulkan avec la couche de validation, Direct3D 12, Dawn) : la compaction de cinq candidats en deux lots (dedans, dehors, à cheval sur un plan, sans bornes), les instances et les arguments relus ; WebGL2 n'a pas la capacité.
- **La même image** avec et sans `gpuCulling`, sur les quatre backends, deux frames de suite : des objets hors du frustum, instanciés, un mesh sans indices (`drawIndirect`), des transparents, un lot sans instance visible.
- **CPU** (`Renderer.spec`) : les dispatches de la passe de culling, les draws indirects sans instances écrites par le CPU, le repli sans la capacité.

## 8. Les étapes

| Étape                                  | Contenu                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Les draws indirects**             | L'API, les trois backends, le refus de WebGL2, les tests de rendu                                                                                                          |
| **2. Le culling des instances**        | La compaction (§3.2), `gpuCulling` dans les passes de scène, `instanceBuffer`                                                                                              |
| **3. L'occlusion sans retard**         | Les deux phases de P3 : la visibilité de la frame précédente par ligne sur le GPU, la pyramide, le test du reste contre elle dans le même calcul                           |
| **4. La tessellation en calcul**       | Les niveaux des patchs de P3b choisis par un calcul, le nombre de patchs par draw indirect                                                                                 |
| **5. Les lumières**                    | Le remplissage des clusters de P2 en calcul                                                                                                                                |
| **6. Les tables de la scène**          | L'option B (§2) : un allocateur de meshes, `multiDrawIndirect` et `drawIndirectCount` ; les instances persistantes à l'étape 7                                             |
| **7. La scène sur le GPU** (en partie) | Les instances persistantes (`GpuScene` : le CPU n'écrit que ce qui change, plus de préparation par objet) faites ; restent les matériaux sans changement d'état (bindless) |

## 9. Décisions

- **Un draw par lot du CPU** plutôt que les tables de la scène : les draws indirects et la compaction d'abord, sans toucher aux matériaux.
- **Le préfixe en plusieurs dispatches** plutôt que des atomiques : le compilateur reste le même sur les quatre backends, et la compaction est stable.
- **WebGPU compris** quand il a `indirect-first-instance` : le même code que Vulkan, testé sur Dawn.
- **La pyramide de P3 réutilisée** (passes plein écran) pour la seconde phase, et son test ajouté au graphe de calcul (`boxVisibility`) : un seul test des boîtes pour les deux chemins ; la pyramide en calcul reste la suite de P3.
- **Les clusters par paires** (cluster × lumière) plutôt qu'une boucle par cluster : sans écriture dans les boucles ni atomiques, la compaction stable donne les listes du CPU ; la mémoire (trois u32 par paire) limite à 1024 lumières.
- **Un storage buffer pour les tracés des patchs**, sur les deux chemins : le calcul n'écrit pas de textures, et un seul graphe de matériau.
- **Le nombre de sommets recopié par le `Renderer`** (une passe de copie) plutôt qu'écrit par le producteur avec la première instance, que seul le `Renderer` connaît, à l'exécution.
- **Une `GpuScene` explicite** plutôt que la scène graph elle-même : l'application dit ce qui est statique et ce qui bouge (`touch`, `dynamic`), sans balayer les versions de tous les objets à chaque frame ; le scene graph reste la source des transparents et des ombres.
- **Le bindless remis à plus tard** : ni WebGPU ni le compilateur ne le permettent aujourd'hui ; les lots par matériau suffisent tant que les matériaux sont peu nombreux.
- **Les meshes d'une arène toujours en indirect** : `drawIndexed` n'a ni premier indice ni sommet de base dans l'API (et WebGL2 n'a pas de sommet de base) ; l'indirect les porte.

## 10. État

_Étapes 3, 4, 5 et la première part de 6 faites, mesures prises (5 novembre 2026)_ : l'occlusion en deux phases sans retard (`OcclusionCuller.addPyramid`, l'historique par ligne) ; les clusters de lumières remplis par le GPU ; les niveaux de tessellation en calcul (`levels: 'gpu'`, `Mesh.setGpuVertexCount`, le storage buffer des tracés) ; `multiDrawIndirect` et `drawIndirectCount` sur Vulkan, Direct3D 12 et WebGPU (sans nombre), `MeshArena` et les draws multiples ; la touche G et la scène `city-gpu` de la démo ; les guides et tutoriels (backends, occlusion culling, tessellation, nombreuses lumières ; EN, FR). Puis l'étape 7, la scène gardée sur le GPU (`GpuScene`, l'option `gpuScene`) : le CPU d'une frame à 1 ms pour 10 000 comme pour 100 000 immeubles. Reste le bindless (§3.8).

_Étapes 1 et 2 faites (4 novembre 2026)_ : `drawIndirect` et `drawIndexedIndirect` sur Vulkan, Direct3D 12 et WebGPU (`indirect-first-instance`), la capacité `indirectDraw` ; la compaction sans atomiques (`engine-core/src/render/gpuCulling.ts`) ; l'option `gpuCulling` des passes de scène ; `GpuObjectTable.instanceBuffer` ; le guide des backends (EN, FR). Reste : les mesures (§6) et les étapes 3 à 6.
