# P10 : le ray tracing

Le design de la phase P10 de la [roadmap](roadmap.md#p10-ray-tracing) : des rayons lancés depuis les shaders (l'hybride : les ombres, l'occlusion ambiante, les reflets), puis toute l'image par rayons (le path tracer) ; en matériel sur Vulkan, en logiciel (WGSL) sur WebGPU ; la rastérisation toujours disponible, le ray tracing une option du rendu.

Contraintes : la même technique sur les deux backends, seule la traversée change ([§6 de la roadmap](roadmap.md#6-rester-compatible-avec-le-ray-tracing)) ; les matériaux écrits une fois, compilés vers la rastérisation et vers les rayons ; rien de lourd en dépendance ; WebGL2 inchangé (la rastérisation seule).

## 1. Les choix

| Question                        | Choix                                                                                                                                                                                                     | Écartés, et pourquoi                                                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Les rayons en Vulkan            | **Les ray queries** (`VK_KHR_ray_query`), dans tous les stages : fragment (l'hybride) et calcul (le path tracer)                                                                                          | Les pipelines de ray tracing (`VK_KHR_ray_tracing_pipeline`) : une table de shaders par matériau, des stages de plus dans le compilateur et dans l'API abstraite, sans équivalent en WebGPU ; à revoir si les ray queries plafonnent                    |
| Les rayons en WebGPU            | **Un BVH construit sur le CPU, parcouru en WGSL** : le code de la traversée émis par le générateur WGSL, comme une fonction intrinsèque                                                                    | Une traversée en compute graphs : ni pile, ni boucle à sortie anticipée (les `fold` ont un nombre d'itérations fixe), un BVH sans pile (liens « hit / miss ») visiterait trop de nœuds ; la construction sur le GPU : à faire quand le CPU ne suit plus |
| Le BVH logiciel                 | **Deux niveaux**, comme le matériel : un BVH par mesh (SAH par paniers), un BVH des instances reconstruit à chaque image ; des nœuds binaires qui portent les boîtes de leurs deux enfants                | Un seul BVH de tous les triangles de la scène : reconstruit dès qu'un objet bouge ; un BVH à 4 ou 8 enfants : plus rapide, plus de code, à mesurer d'abord                                                                                            |
| Le résultat d'un rayon          | **Un `vec4<u32>`** : l'instance (ou `0xffffffff`), le triangle et la face, les coordonnées barycentriques en bits ; des fonctions de graph en tirent la position, la normale, les uv, l'objet             | Un type structure dans l'IR : des générateurs à refaire pour un seul usage ; un `vec4<f32>` : ni l'instance ni le triangle exacts au-delà de 2²⁴                                                                                                       |
| Les données des impacts         | **Trois storage buffers du moteur** (les instances, les indices, les sommets : position, normale, uv, tangente), communs aux deux backends ; la traversée seule est propre au backend                    | Les vertex buffers des meshes lus tels quels : leurs formats (float16, snorm8…) et leur entrelacement à décoder dans les shaders                                                                                                                       |
| Le matériau au point d'impact   | **La cible « impact » du compilateur** : la surface du matériau compilée en un programme de calcul, les attributs interpolés au point d'impact ; un dispatch par matériau, les fils des autres sautés      | Un uber-shader de tous les matériaux : l'IR n'a pas de `switch`, tous seraient évalués ; une table de couleurs constantes par matériau : ni textures, ni matériaux procéduraux                                                                         |
| La BSDF                         | **Celle du modèle `pbr`** (Lambert et GGX, métal et rugosité), écrite une fois dans l'intégrateur ; la surface lui donne ses paramètres (la « cible BSDF »)                                               | Une BSDF compilée par matériau : chaque modèle d'éclairage en trois fonctions (évaluation, tirage, densité) ; pour les modèles du moteur, la surface `pbr` suffit                                                                                       |
| Le path tracer                  | **En vagues** (wavefront) : les rayons dans des buffers, un dispatch par étape (tracer, les surfaces, intégrer), les rebonds à la suite                                                                   | Un seul noyau par pixel : il faudrait tous les matériaux dans un programme (voir plus haut)                                                                                                                                                             |
| Le débruitage                   | **L'accumulation** tant que la caméra ne bouge pas, puis **un filtre à trous** (Dammertz) guidé par la normale, la profondeur et l'albédo du premier impact                                               | SVGF (temporel, avec reprojection) : à ajouter pour une caméra qui bouge ; les débruiteurs à réseau de neurones (OIDN, OptiX) : de grosses dépendances, hors du navigateur                                                                              |
| Les ombres de l'hybride         | **Dans le matériau** : la macro `light.shadow` trace un rayon vers la lumière (la feature `rayShadows`), à la place de l'atlas d'ombres                                                                   | Une passe d'ombres en écran (un masque par lumière) : une cible par lumière, et le rendu avant de connaître les lumières de chaque pixel                                                                                                                |
| Les reflets et l'occlusion      | **Des passes en espace écran** sur les sorties de P2b (normale, rugosité, profondeur) : les rayons partent des pixels ; les reflets réutilisent les étapes du path tracer pour un rebond                  | Dans le matériau : le matériau touché par un reflet n'est pas connu du fragment shader                                                                                                                                                                  |

## 2. Les structures d'accélération

L'API abstraite (`engine-backend`) gagne deux objets, sur les backends de capacité `rayQuery` :

- `createBottomLevel({ positions, indices, label })` : le BVH d'un mesh, depuis ses positions (`Float32Array`, xyz par sommet) et ses indices (`Uint32Array`). Construit à la création.
- `createTopLevel({ capacity, label })` : la scène ; `update(instances)` y écrit les instances (un BVH du bas, une matrice monde 3 × 4, un masque de 8 bits), puis `encoder.buildTopLevel(top)` le construit, avant les passes qui le lisent.

Le **binding** `acceleration-structure` (le type `acceleration-structure` des graphs) se lie comme une texture, au groupe `frame` : `input.engine('scene')`.

**WebGPU** (logiciel) : le BVH du bas est construit sur le CPU (SAH, 12 paniers par axe, des feuilles de 4 triangles au plus) ; ses nœuds et ses triangles sont ajoutés aux buffers communs du backend (`nodes` et `triangles`, qui grandissent). `update` construit le BVH des instances sur le CPU et l'écrit avec les instances dans un troisième buffer (`top`). Le binding est donc trois storage buffers, et la traversée une fonction WGSL émise par le générateur dans les programmes qui tracent : une pile de 32 entrées par niveau, les deux enfants testés ensemble, le plus proche d'abord, le test de Möller-Trumbore.

| Buffer      | Contenu                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nodes`     | Par nœud, 4 `vec4` : les boîtes des deux enfants (min, max), et en w l'indice de l'enfant (nœud, ou premier triangle d'une feuille) et le nombre de triangles (0 : un nœud) |
| `triangles` | Par triangle, 3 `vec4` : v0, v1 − v0, v2 − v0 ; en w de v0 l'indice du triangle dans le mesh                                                                    |
| `top`       | Un en-tête (le nombre de nœuds), les nœuds des instances, puis par instance 4 `vec4` : la matrice monde → objet (3 × 4), le premier nœud et le premier triangle de son BVH, son masque |

**Vulkan** (matériel) : `VK_KHR_acceleration_structure` et `VK_KHR_ray_query` (et l'adresse des buffers, `bufferDeviceAddress`), activées quand le GPU les a ; les BLAS construits à la création (une soumission attendue), la TLAS à chaque image par `vkCmdBuildAccelerationStructuresKHR`, suivie d'une barrière vers la lecture par les shaders. En HLSL, `RayQuery` et `TraceRayInline`, compilé par DXC (`SPV_KHR_ray_query`).

**WebGL2** : pas de calcul ni de storage buffers dans les fragment shaders : pas de capacité `rayQuery`. Le renderer garde ses ombres en cartes.

## 3. Les rayons dans les graphs

- **`ray.trace`** (l'opération `ray-query` de l'IR) : `scene`, `origin`, `direction`, `tMin`, `tMax` ; le paramètre `mode` : `closest` (l'impact le plus proche) ou `any` (le premier trouvé : les ombres, l'occlusion). Le résultat, un `vec4<u32>` : x l'instance (`0xffffffff` sans impact), y le triangle (le bit 31 : vu de dos), z et w les coordonnées barycentriques u, v (les bits d'un `f32`).
- **`std.bitcast`** : les bits d'un scalaire ou d'un vecteur de 32 bits vus dans un autre type (`f32` ↔ `u32` ↔ `i32`).
- **Les fonctions des impacts** (`ray.*`, des graphs de fonction) lisent les buffers du moteur (`rayInstances`, `rayIndices`, `rayVertices`, des ressources `input.engine` du groupe `frame`) : `ray.hit` (bool), `ray.hitPosition`, `ray.hitNormal` (interpolée, en monde), `ray.hitGeometricNormal`, `ray.hitUv`, `ray.hitTangent`, `ray.hitObject` (l'identifiant de l'objet), `ray.hitMaterial` (l'indice du matériau dans la scène tracée).
- **`light.shadow`** : avec la feature `rayShadows`, un rayon `any` vers la lumière (`light.shadowRay`), parti du point décalé le long de la normale ; avec `shadowSamples` > 1 et un rayon de lumière (`softness`), plusieurs rayons dans le cône de la lumière : la pénombre.
- **Le garde des programmes de calcul** : `output.compute` gagne une entrée `active` (bool) ; les fils où elle est fausse sautent le reste du programme et n'écrivent rien. Le générateur émet d'abord ce dont le garde dépend.

Les instances de la scène tracée (`rayInstances`, 8 `vec4` chacune) : la matrice objet → monde (3 × 4), la matrice des normales (3 × 3, colonnes en vec4), puis le premier indice, le premier sommet, l'indice du matériau, l'identifiant de l'objet (en `u32`). Les sommets (`rayVertices`, 3 `vec4`) : position et u, normale et v, tangente.

## 4. La scène tracée

`RayScene` (`@fdw/engine-raytracing`) tient la scène des rayons d'une `RenderSource` ou d'une liste d'items : un BVH du bas par mesh (gardé tant que le mesh ne change pas), ses indices et ses sommets ajoutés aux buffers du moteur ; à chaque image, les instances (les items de la source, toutes couches choisies, sans culling), la TLAS mise à jour et construite, la table des matériaux (un indice par matériau distinct). Les items exclus : les lignes, les meshes sans positions ni indices, ceux dont le matériau le demande (`rayTracing: false`), les transparents des ombres.

Le `Renderer` accepte une scène tracée par vue (`rays`) : il lie ses ressources au groupe `frame` des matériaux qui les lisent, et compile les matériaux avec la feature `rayShadows` quand la vue demande des ombres tracées (sans atlas d'ombres).

## 5. L'hybride

1. **Les ombres** : dans les matériaux (§3). Dures avec un rayon par lumière ; douces avec `shadowSamples` rayons et un bruit par pixel.
2. **L'occlusion ambiante** (`RayAmbientOcclusion`) : une passe de calcul depuis la profondeur et la normale des sorties de P2b ; `samples` rayons `any` en cosinus, sur `radius` mètres ; un flou bilatéral ; le résultat multiplie la lumière ambiante, comme celui du SSAO.
3. **Les reflets** (`RayReflections`) : depuis la profondeur, la normale et la rugosité, un rayon réfléchi par pixel (les plus rugueux exclus), tracé, sa surface évaluée et éclairée par les étapes du path tracer (un rebond, l'ombre de la lumière tracée) ; le ciel quand il ne touche rien ; mélangé à la couleur par Fresnel.

## 6. Le path tracer

`PathTracer` : une technique de rendu du render graph, à côté de `addScenePasses`. Par image, pour chaque rebond (`bounces`, 4) :

1. **Tracer** : les rayons du buffer `rays` (origine, direction, poids, le pixel), l'impact le plus proche → `hits`.
2. **Les surfaces** : un dispatch par matériau de la scène, son programme « impact » (§7) : les fils dont l'impact est de ce matériau écrivent la surface (couleur, métal, rugosité, normale, émission, alpha) → `surfaces`.
3. **Intégrer** : l'émission ; la lumière directe (une lumière tirée au hasard, un rayon d'ombre `any`) ; le ciel pour les rayons perdus ; le rebond suivant, tiré selon la BSDF (Lambert ou GGX selon le métal et la rugosité, le rapport des densités pour le poids), la roulette russe après deux rebonds ; l'alpha sous le seuil laisse passer le rayon (le feuillage).

Puis **l'accumulation** (la moyenne des images depuis que la caméra et la scène sont immobiles), **le débruitage** (5 passes d'à-trous sur l'éclairage divisé par l'albédo), le tone mapping. Les rayons de la caméra sont décalés dans le pixel (l'anticrénelage).

## 7. La cible « impact » du compilateur

`compileHit(graph, options)` (`engine-shader`) compile la surface d'un matériau (`output.surface`) en un programme de calcul :

- `input.attribute` (position, normale, uv, tangente) : interpolés au point d'impact (`ray.hit*`) ; les attributs absents des sommets tracés valent leur défaut ;
- `object.world`, `object.normalMatrix`, `object.id` : ceux de l'instance touchée ;
- `std.textureSample` : au niveau 0 (`textureSampleLevel`) ; les dérivées (`dpdx`, `dpdy`, `fwidth`) : 0 ; `front-facing` : la face touchée ;
- la surface : écrite dans le buffer `surfaces` à l'indice du rayon (4 `vec4` : couleur et alpha, normale et rugosité, émission et métal, l'occlusion) ; le garde `active` : un impact de ce matériau.

Les modèles d'éclairage autres que `pbr` (phong, toon, unlit) donnent leur couleur de base et leur émission ; `unlit` devient de l'émission.

## 8. Tests

- **`engine-geometry`** : le BVH (chaque triangle dans une feuille, les boîtes qui contiennent leurs enfants, le SAH meilleur qu'un découpage au milieu) ; la traversée sur le CPU égale à la force brute sur des rayons au hasard.
- **`engine-shader`** : `ray.trace`, `std.bitcast`, le garde, les fonctions des impacts ; la cible « impact » (attributs, objet, niveaux de texture, dérivées).
- **Suite de rendu** (Dawn, Vulkan sur le GPU et sur lavapipe, avec la couche de validation) : les rayons d'un compute graph contre une scène connue (distances, instances, triangles, barycentriques égaux à la traversée du CPU) ; les ombres tracées dans un matériau ; l'occlusion ; un reflet ; une image du path tracer qui converge vers la référence.
- **Documentation** : les tutoriels (EN, FR) avec leurs exemples vivants en WebGPU.

## 9. Reportés

- Les meshes déformés sur le GPU (le skinning de P6, la mer de P17, la tessellation de P3b) : leurs BLAS sont ceux de la pose de repos ou absents ; la mise à jour (refit) depuis les buffers du calcul viendra ensuite.
- L'alpha testé pendant la traversée (le feuillage dans les ombres et l'occlusion) ; le path tracer le traite par des rebonds à travers.
- Les pipelines de ray tracing de Vulkan, DXR sur Direct3D 12, le BVH construit sur le GPU, les BVH à 4 enfants.
- SVGF, ReSTIR, l'échantillonnage des textures d'environnement par importance.
