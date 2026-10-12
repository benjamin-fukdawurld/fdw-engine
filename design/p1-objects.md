# P1 : les données d'objet, puis l'instancing

Réduire le coût par objet du rendu ([roadmap P1](roadmap.md#p1-performance-du-rendu)). Le premier commit de P1 évite déjà les changements d'état redondants dans une passe (pipeline, bind groups, buffers de sommets et d'index). Ce document traite des étapes suivantes : regrouper les données d'objet (étape 1), puis l'instancing (étape 2). Le batching statique et la création en lot (étape 3) viendront après, sur ce socle.

Contraintes posées : un **mécanisme d'accès aux données d'objet défini dans `engine-backend`**, chaque backend choisissant son implémentation ; aucune dépendance à WebGPU dans `engine-core` ; aucune abstraction que WebGL2 ne puisse respecter.

## 1. Aujourd'hui

Le slot `object` du material graph est un groupe à part, avec un seul bloc uniforme (`world`, `normalMatrix` : 112 octets), lu par `input.engine` (`object.world`, `object.normalMatrix`). Les matériaux n'y accèdent jamais directement. Pour chaque objet, le `Renderer` tient :

- **un buffer uniforme de 112 octets** et **un bind group** par disposition de programme ;
- **une écriture** (`writeBuffer`) quand sa matrice change ;
- **un `setBindGroup`** à chaque draw, puisque chaque objet a le sien.

Mesures (`Renderer.bench.ts`, backend factice, CPU seul) : 1000 objets immobiles, 1,86 ms ; 1000 objets en mouvement, 7,09 ms. Dans le navigateur, chaque appel WebGPU traverse un processus : c'est ce qui rend WebGPU lent sur le labyrinthe (3700 draws).

## 2. Les options

| Option                                                  | Principe                                                                                                        | Intérêt                                                                                                                                                                                                                                                                                             | Coût                                                                                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Un buffer uniforme par frame, offsets dynamiques** | Tous les blocs dans un gros buffer, chaque draw lie le groupe `object` avec son offset                          | Shaders inchangés ; possible partout (offsets dynamiques en WebGPU et Vulkan, `bindBufferRange` en WebGL2) ; supprime les buffers et bind groups par objet                                                                                                                                          | Reste **un `setBindGroup` par draw** (le coût d'appel dans le navigateur demeure) ; alignement de 256 octets par bloc (2,3 fois la mémoire) ; l'instancing demandera un **second mécanisme**             |
| **B. Une table d'objets indexée**                       | Les données de tous les objets dans une table ; chaque instance d'un draw lit sa ligne par son index d'instance | **Aucun appel par draw** pour l'objet : le groupe est lié une fois par passe ; **l'instancing est le même mécanisme** (étape 2 presque gratuite) ; mémoire compacte ; ce sont les **tables indexées** que demande le ray tracing ([roadmap §6](roadmap.md#6-rester-compatible-avec-le-ray-tracing)) | Touche le compilateur (l'accès à l'objet passe par un index) et les trois générateurs ; une subtilité en Vulkan (index d'instance de HLSL) ; en WebGL2, une texture de données lue dans le vertex shader |

**Recommandation : B.** A ne règle qu'à moitié le coût d'appel, et l'instancing devrait de toute façon inventer un accès aux données d'objet par instance. B résout les deux d'un coup, et c'est la forme que la roadmap a déjà promise pour le ray tracing.

## 3. Le mécanisme : une table d'objets

### 3.1 Le contrat, dans `engine-backend`

- **Une table d'objets** : des lignes de taille fixe (aujourd'hui `world` et `normalMatrix`), créée par le backend (`backend.createObjectTable(layout)`). Le `Renderer` écrit des lignes (`write(first, data)`, par plages) ; le backend choisit la mémoire.
- **Une liste d'instances** par frame : pour chaque instance dessinée, l'index de sa ligne dans la table (`u32`). C'est une indirection : les lignes restent **stables** (un objet garde la sienne tant qu'il vit, réécrite seulement quand il bouge), alors que l'ordre des draws change à chaque frame.
- **Le draw** : `draw(vertexCount, instanceCount, firstInstance)` et `drawIndexed(indexCount, instanceCount, firstInstance)`. L'instance `i` d'un draw lit la ligne `instances[firstInstance + i]`. Un draw d'un seul objet est un draw d'une instance.
- **Le groupe `object`** devient un groupe de ressources du backend (la table et la liste), lié **une fois par passe**.

Ce que chaque backend en fait :

| Backend | Table                                            | Liste d'instances             | `firstInstance`                                                                                                                                                                 |
| ------- | ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGPU  | Storage buffer (`array<ObjectRecord>`)           | Storage buffer (`array<u32>`) | `instance_index` l'inclut déjà                                                                                                                                                  |
| Vulkan  | Storage buffer                                   | Storage buffer                | Base instance de Vulkan ; le HLSL de DXC l'exclut de `SV_InstanceID` : on lit `BaseInstance` à part (`-fvk-support-nonzero-base-instance` ou `[[vk::builtin("BaseInstance")]]`) |
| WebGL2  | Texture de données (RGBA32F, 7 texels par ligne) | Texture de données (R32UI)    | Pas de base instance : le backend pose un uniform avant chaque draw (`uniform1ui`, un appel GL local, sans traversée de processus)                                              |

`engine-core` ne voit que la table, la liste et `firstInstance`.

### 3.2 Dans le compilateur

- La disposition logique du slot `object` devient une **table** (une nouvelle sorte de binding, `object-table`, avec les membres de ligne), au lieu d'un bloc uniforme. Chaque stratégie de disposition la résout physiquement : storage buffers en WebGPU et Vulkan, textures en WebGL2.
- Une lecture `input.engine` de `object.world` devient, dans l'IR, la lecture d'un membre de la ligne de l'**index d'objet**. Chaque générateur l'écrit à sa façon : `objects[instances[instance_index]].world` en WGSL, `texelFetch` sur 4 texels en GLSL, etc.
- **Dans le fragment shader**, l'index d'objet arrive par une varying `flat`, ajoutée seulement si le fragment lit des données d'objet.
- Les matériaux ne changent pas : ils lisent toujours `object.world` par `input.engine`.

### 3.3 Dans le `Renderer`

- **Une ligne par `ObjectState`**, attribuée à la première rencontre, libérée quand l'état disparaît. Une ligne n'est écrite que si sa version change. Les écritures d'une frame sont regroupées en plages contiguës : quelques `writeBuffer` au lieu d'un par objet.
- **Les objets d'un `TransformPool`** : le début de leur bloc du pool a déjà la disposition de la ligne (c'est le cas du bloc uniforme actuel). Une copie, sans recalcul.
- **Par passe** : la liste d'instances suit l'ordre des draws triés, et est envoyée en une écriture. Le groupe `object` est lié une fois.
- **L'instancing (étape 2)** : des draws consécutifs de même pipeline, même matériau et même mesh deviennent **un seul draw** de N instances. Le tri actuel (pipeline, puis matériau) gagne une troisième clé, le mesh. Les ombres en profitent de la même façon.

### 3.4 Ce que ça coûte par frame

|                                   | Aujourd'hui                   | Avec la table                                         |
| --------------------------------- | ----------------------------- | ----------------------------------------------------- |
| Bind groups `object`              | Un par objet (créés une fois) | Un par disposition et par table                       |
| `setBindGroup` du groupe `object` | Un par draw                   | Un par passe                                          |
| Écritures de données d'objet      | Une par objet qui bouge       | Quelques plages, plus une liste d'instances par passe |
| Draws                             | Un par objet                  | Un par groupe d'objets identiques (étape 2)           |

## 4. Risques et mesures

- **WebGL2** : 7 `texelFetch` par sommet pour la ligne, plus 1 pour l'index. Le labyrinthe dessine des cubes (24 sommets) : négligeable, mais à mesurer (P0 donne maintenant les temps GPU par passe).
- **Les limites** : une texture WebGL2 fait au moins 4096 texels de côté, donc plus de 2 millions de lignes. En WebGPU, un storage buffer garanti fait 128 Mo, soit plus d'un million de lignes.
- **Vulkan** : la base instance avec DXC est le point à vérifier en premier, par un test de la suite de rendu (deux objets, deux lignes, deux couleurs).
- **Les sources du monde** (`WorldRenderItem`) : elles n'ont pas de bloc de pool, donc leur ligne est écrite depuis leur matrice, comme aujourd'hui.
- **La validation** : chaque étape mesurée avant et après, avec `bench.yml` et `runner.passTimes`, sur le labyrinthe (étape 1) et sur la forêt.

## 5. Les étapes

1. **Le contrat** dans `engine-backend` (table, liste d'instances, `firstInstance`), et le binding `object-table` dans le compilateur, l'IR et les trois générateurs. Des tests de génération par langage.
2. **Les backends** : WebGPU, puis Vulkan (la base instance d'abord), puis WebGL2 (les textures de données). Un test commun de la suite de rendu : plusieurs objets, une table, des instances.
3. **Le `Renderer`** : les lignes stables, les plages d'écriture, la liste par passe, le groupe lié une fois. Mesures avant et après.
4. **L'instancing** : la fusion des draws identiques, le tri par mesh, les ombres. Mesures sur le labyrinthe et la forêt.
5. Puis l'étape 3 de P1 : le batching statique par cellule d'octree, la création en lot dans `engine-scene`.

## 6. Résultats de l'étape 1

Les trois backends lisent les données d'objet dans une table (la capacité `objectTable`) : storage buffers en WebGPU et en Vulkan, textures de données en WebGL2. La suite de rendu passe sur les trois (dont un test qui lit l'objet dans le fragment shader), et les programmes de la suite sont validés en HLSL (DXC, spirv-val) et en GLSL ES (glslang).

| Mesure                                                                  | Sans la table | Avec la table        |
| ----------------------------------------------------------------------- | ------------- | -------------------- |
| Labyrinthe, étape 1, Vulkan natif (sans validation)                     | 100 fps       | **125 fps** (+25 %)  |
| Labyrinthe, étape 1, Dawn natif (le backend du navigateur)              | 42 fps        | **71,5 fps** (+70 %) |
| `Renderer.render`, 1000 objets en mouvement (CPU, backend factice)      | 7,06 ms       | **2,12 ms**          |
| `Renderer.render`, 1000 objets immobiles (médiane, 40 séries alternées) | 1,74 ms       | **1,61 ms**          |

Avant P1, l'étape 1 tournait à environ 89 fps sur Vulkan. Le gain de Dawn, plus fort, vient du coût de chaque appel WebGPU : c'est le cas du navigateur.

Ce qui reste du chemin précédent (un bloc uniforme par objet, sans la capacité) sera retiré à la fin de P1, une fois l'instancing en place.
