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
| Les données des impacts         | **Deux storage buffers du moteur** (les instances ; la géométrie : les triangles et les sommets, position, normale, uv, tangente), communs aux deux backends ; la traversée seule est propre au backend | Les vertex buffers des meshes lus tels quels : leurs formats (float16, snorm8…) et leur entrelacement à décoder dans les shaders                                                                                                                       |
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

**WebGPU** (logiciel) : le BVH du bas est construit sur le CPU (SAH, 12 paniers par axe, des feuilles de 4 triangles au plus) ; ses nœuds et ses triangles sont ajoutés au buffer commun du backend (`bottom`, de `vec4`, qui grandit ; les références des nœuds y sont des décalages en `vec4`). `update` construit le BVH des instances sur le CPU et l'écrit avec les instances dans un second buffer (`top`). Le binding est donc deux storage buffers, et la traversée une fonction WGSL émise par le générateur dans les programmes qui tracent : une pile de 32 entrées par niveau, les deux enfants testés ensemble, le plus proche d'abord, le test de Möller-Trumbore.

| Buffer      | Contenu                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bottom`    | Par nœud, 4 `vec4` : les boîtes des deux enfants (min, max), et en w le décalage de l'enfant (nœud, ou premier triangle d'une feuille) et le nombre de triangles (0 : un nœud) ; par triangle, 3 `vec4` : v0, v1 − v0, v2 − v0, en w de v0 l'indice du triangle dans le mesh |
| `top`       | Un en-tête (le nombre de nœuds), les nœuds des instances, puis par instance 4 `vec4` : la matrice monde → objet (3 × 4), le premier nœud et le premier triangle de son BVH, son masque |

**Vulkan** (matériel) : `VK_KHR_acceleration_structure` et `VK_KHR_ray_query` (et l'adresse des buffers, `bufferDeviceAddress`), activées quand le GPU les a ; les BLAS construits à la création (une soumission attendue), la TLAS à chaque image par `vkCmdBuildAccelerationStructuresKHR`, suivie d'une barrière vers la lecture par les shaders. En HLSL, `RayQuery` et `TraceRayInline`, compilé par DXC (`SPV_KHR_ray_query`).

**La face** : en Vulkan, un triangle anti-horaire vu depuis l'origine du rayon est de face, comme pour la rastérisation du moteur : les instances n'ont pas `TRIANGLE_FLIP_FACING` (le test qui compare au CPU l'a montré), seulement `TRIANGLE_FACING_CULL_DISABLE`. La TLAS qui grandit est recréée : sa `version` change, les groupes qui la tiennent sont refaits. Le Shader Model 6.5 est demandé à DXC pour les seuls programmes qui tracent (`RayQuery<`). lavapipe (Mesa 25) a les ray queries : la CI les teste sans GPU.

**WebGL2** : pas de calcul ni de storage buffers dans les fragment shaders : pas de capacité `rayQuery`. Le renderer garde ses ombres en cartes.

## 3. Les rayons dans les graphs

- **`ray.trace`** (l'opération `ray-query` de l'IR) : `scene`, `origin`, `direction`, `tMin`, `tMax` ; le paramètre `mode` : `closest` (l'impact le plus proche) ou `any` (le premier trouvé : les ombres, l'occlusion). Le résultat, un `vec4<u32>` : x l'instance (`0xffffffff` sans impact), y le triangle (le bit 31 : vu de dos), z et w les coordonnées barycentriques u, v (les bits d'un `f32`).
- **`std.bitcast`** : les bits d'un scalaire ou d'un vecteur de 32 bits vus dans un autre type (`f32` ↔ `u32` ↔ `i32`).
- **Les fonctions des impacts** (`ray.*`, des graphs de fonction) lisent les buffers du moteur (`rayInstances`, `rayGeometry`, des ressources `input.engine` du groupe `frame`) : `ray.hit` (bool), `ray.hitPosition`, `ray.hitNormal` (interpolée, en monde), `ray.hitGeometricNormal`, `ray.hitUv`, `ray.hitTangent`, `ray.hitObject` (l'identifiant de l'objet), `ray.hitMaterial` (l'indice du matériau dans la scène tracée).
- **`light.shadow`** : avec la feature `rayShadows`, un rayon `any` vers la lumière (`light.shadowRay`), parti du point décalé le long de la normale ; avec `shadowSamples` > 1 et un rayon de lumière (`softness`), plusieurs rayons dans le cône de la lumière : la pénombre.
- **Le garde des programmes de calcul** : `output.compute` gagne une entrée `active` (bool) ; les fils où elle est fausse sautent le reste du programme et n'écrivent rien. Le générateur émet d'abord ce dont le garde dépend.

Les instances de la scène tracée (`rayInstances`, 8 `vec4` chacune, `RayInstanceVec4s`) : la matrice objet → monde par lignes (3 `vec4`), la matrice des normales (3 colonnes en `vec4`), puis les bits de quatre `u32` : le `vec4` du premier triangle de son mesh dans `rayGeometry`, son matériau, l'identifiant de son objet, ses drapeaux (`RayInstanceFlags` : double face, alpha) ; un `vec4` de l'application. La géométrie (`rayGeometry`, de `vec4`) : un `vec4` par triangle (les décalages des enregistrements de ses trois sommets), et 3 `vec4` par sommet : position et u, normale et v, tangente.

**Huit storage buffers au plus** : WebGPU n'en garantit que 8 par stage, et les navigateurs (SwiftShader, Chrome) s'y tiennent. La première version liait jusqu'à 16 buffers dans le noyau des rebonds (trois pour la structure, trois pour les impacts, les rayons, les poids, la radiance en double…) : Dawn sur le GPU les acceptait, le navigateur dessinait du noir. D'où deux buffers par structure, deux pour les impacts, les chemins en un buffer (4 `vec4` : origine, direction, poids, radiance), et le point touché écrit par le programme « impact » (le noyau des rebonds ne lit plus la géométrie). Un test compte les buffers de chaque noyau.

**Les masques** (`RayMasks`) : les rayons de la caméra et des reflets voient les instances visibles (bit 1) ; les rayons d'ombre les seules qui portent ombre (bit 2 : ni les transparents, ni `castShadow: false`).

**Un raté lit l'instance 0** : les fonctions des impacts d'un rayon perdu lisent les buffers à l'instance 0, pas à `0xffffffff × 8` : sans accès robustes (lavapipe), une lecture hors des buffers fait planter le processus.

**Le garde** : `output.compute` a une entrée `active` ; le générateur de l'IR émet d'abord ce dont elle dépend (`IrEntryPoint.active` : la valeur et le nombre d'instructions qui la calculent), les générateurs WGSL et HLSL testent `if (!active) return;` juste après.

## 4. La scène tracée

`RayScene` (`@fdw/engine-raytracing`) tient la scène des rayons d'une `RenderSource` ou d'une liste d'items : un BVH du bas par mesh (gardé tant que le mesh ne change pas), ses indices et ses sommets ajoutés aux buffers du moteur ; à chaque image, les instances (les items de la source, toutes couches choisies, sans culling), la TLAS mise à jour et construite, la table des matériaux (un indice par matériau distinct). Les items exclus : les lignes, les meshes sans positions ni indices, ceux dont le matériau le demande (`rayTracing: false`), les transparents des ombres.

Le `Renderer` accepte une scène tracée par vue (`rays: { scene, shadows }`, l'interface `TracedScene` d'`engine-core`, sans dépendre d'`engine-raytracing`) : il lie ses ressources au groupe `frame` des programmes qui les lisent (refait quand sa `version` change : un buffer a grandi), et compile les matériaux avec les features `rayShadows` et `rayShadowSamples` (dans la clé de la passe) ; les lumières qui portent ombre reçoivent `shadow = (1, 0, offset, softness)`, sans atlas d'ombres. Une passe plein écran trace aussi (`addFullscreenPass(…, { rays })`). `addToneMappingPass` et `executeGraph` sont publics : les techniques de rayons composent leur graph.

Les items exclus par défaut : les meshes sans triangles (lignes), sans positions, et ceux dont le matériau fait sa géométrie dans le vertex stage (`output.attribute`, `vertex-index` : le terrain en patchs) ; les démos excluent aussi les meshes skinnés (`RayView`). `update()` compare les enregistrements des instances à ceux d'avant : `revision` change quand la scène change (le path tracer recommence alors son accumulation).

## 5. L'hybride

1. **Les ombres** : dans les matériaux (§3). Dures avec un rayon par lumière ; douces avec `samples` rayons sur une spirale de Vogel du disque de la lumière, tournée par un bruit par pixel (des appels dépliés : un `fold` ne peut pas dépendre de `light.current`).
2. **L'occlusion ambiante** (`RayOcclusion`) : une passe plein écran qui trace dans son fragment shader, depuis la position et la normale du G-buffer ; `samples` rayons `any` en cosinus sur `radius` mètres ; un flou 5 × 5 qui garde les voisins de la même surface (normales et positions proches) ; une texture d'ouverture (1 ouvert, 0 caché).
3. **Les reflets** (`RayReflections`) : en passes de calcul, un rayon réfléchi par pixel plus lisse que `maxRoughness`, tracé, sa surface évaluée par le programme « impact » de son matériau, éclairée par toutes les lumières (un `fold` sur elles, un rayon d'ombre chacune) et la lumière ambiante ; le ciel quand il ne touche rien ; ajouté à l'image par le Fresnel de la surface, effacé avec la rugosité.

**Le G-buffer** (`reflectionOutputs()`) : la position, la normale avec la rugosité en w, la couleur de base avec la métallicité en w : trois `rgba16float` et la couleur, 32 octets par pixel, la limite de WebGPU (`maxColorAttachmentBytesPerSample`) ; une quatrième sortie la dépassait.

## 6. Le path tracer

`PathTracer` : une technique de rendu du render graph, à côté de `addScenePasses`. Par image, pour chaque rebond (`bounces`, 4) :

1. **Tracer** : les rayons du buffer `rays` (origine, direction, poids, le pixel), l'impact le plus proche → `hits`.
2. **Les surfaces** : un dispatch par matériau de la scène, son programme « impact » (§7) : les fils dont l'impact est de ce matériau écrivent la surface (couleur, métal, rugosité, normale, émission, alpha) → `surfaces`.
3. **Intégrer** : l'émission ; la lumière directe (une lumière tirée au hasard, un rayon d'ombre `any`) ; le ciel pour les rayons perdus ; le rebond suivant, tiré selon la BSDF (Lambert ou GGX selon le métal et la rugosité, le rapport des densités pour le poids), la roulette russe après deux rebonds ; l'alpha sous le seuil laisse passer le rayon (le feuillage).

Puis **l'accumulation** (la moyenne des images depuis que la caméra, la scène, ses matériaux et ses lumières sont immobiles ; les échantillons plafonnés à `maxRadiance` en luminance, contre les lucioles), **le débruitage** (5 passes d'à-trous sur l'éclairage divisé par l'albédo, guidées par la normale et la distance du premier impact ; jusqu'à 256 images), le tone mapping du renderer. Les rayons de la caméra sont décalés dans le pixel (l'anticrénelage). Les lumières sont dans un buffer à part (`packLights`, 4 `vec4` chacune) : `light.current` n'existe pas dans un compute graph.

**Le ciel des rayons perdus** a pour normale de guide la direction inverse : avec une normale nulle, le filtre à trous donnait un poids nul à tous ses voisins, et le ciel sortait noir.

**Les bind groups** : le `ComputeRunner` partage les uniforms des dispatchs d'une soumission qui lient les mêmes ressources ; ceux des rebonds (le numéro du rebond), des passes du filtre et des matériaux (deux matériaux du même graph) les écrasaient. `ComputeDispatch.owner` sépare leurs groupes ; le runner du path tracer garde 4 096 groupes (un frame en lie quelques-uns par matériau et par rebond : à 256, des groupes encore enregistrés étaient détruits).

## 7. La cible « impact » du compilateur

`compileHit(graph, options)` (`engine-shader`) compile la surface d'un matériau (`output.surface`) en un programme de calcul :

- `input.attribute` (position, normale, uv, tangente) : interpolés au point d'impact (`ray.hit*`) ; les attributs absents des sommets tracés valent leur défaut ;
- `object.world`, `object.normalMatrix`, `object.id` : ceux de l'instance touchée ;
- `std.textureSample` : au niveau 0 (`textureSampleLevel`) ; les dérivées (`dpdx`, `dpdy`, `fwidth`) : 0 ; `front-facing` : la face touchée ;
- la surface : écrite dans le buffer `surfaces` à l'indice du rayon (5 `vec4`, `RaySurfaceVec4s` : couleur et alpha, normale et rugosité, émission et métal, l'occlusion, l'unlit et le seuil d'alpha, le point touché) ; le garde `active` : un impact de ce matériau.

Les modèles d'éclairage autres que `pbr` (phong, toon, unlit) donnent leur couleur de base et leur émission ; `unlit` devient de l'émission.

## 8. Tests

- **`engine-geometry`** (10 tests) : le BVH (chaque primitive dans une seule feuille, les boîtes qui contiennent leurs enfants, une feuille pour quelques primitives, le SAH qui sépare deux amas) ; la traversée égale à la force brute sur des rayons au hasard (le plus proche, le premier trouvé, les barycentriques, la face) ; deux niveaux d'instances tournées et mises à l'échelle, les masques.
- **`engine-shader`** (10 tests) : `ray.trace` (l'opération, le binding de la scène, la capacité exigée), les fonctions des impacts et leurs buffers, `std.bitcast` vérifié, le garde des compute graphs, les ombres par rayons (un rayon par lumière, plusieurs pour les douces), la cible « impact » (les écritures, les niveaux de texture, les slots, la tangente des normal maps, le seuil des masqués, les refus).
- **`engine-raytracing`** (4 tests) : les données des meshes pour les rayons (les normales calculées, les meshes non indexés, les lignes exclues), les lumières empaquetées.
- **Suite de rendu** (6 tests, Dawn, Vulkan sur le GPU et sur lavapipe, avec la couche de validation) : des rayons au hasard dans une scène d'instances, impacts égaux au CPU (instance, triangle, face, barycentriques ; `any` ; une mise à jour plus petite ; une scène vide) ; les points touchés (position, normale, uv, objet, matériau, normale géométrique, un raté) ; les ombres tracées dans les matériaux (dures, qui suivent l'objet déplacé, douces) ; un sol miroir qui reflète un carré rouge ; l'occlusion au pied d'un mur ; le path tracer qui converge vers l'éclairement analytique d'un sol, la couleur d'une lampe, l'ombre d'un bloc.
- **Documentation** : le guide « Le ray tracing », les tutoriels « Les ombres par rayons », « Les reflets et l'occlusion ambiante par rayons », « Le path tracing » (EN, FR), leurs trois exemples vivants et leurs captures (WebGPU sur SwiftShader ; le repli rasterisé en WebGL2).

## 9. Mesures

Les démos natives, 1280 × 720, RTX 2060 SUPER, sans vsync, tout compris (la scène, la physique, le rendu ; le TPS sur 1 500 images, son chargement compris) :

| Démo | Rendu         | Vulkan (matériel) | Dawn (logiciel, WGSL) |
| ---- | ------------- | ----------------- | --------------------- |
| FPS  | Rastérisé     | 974 fps           | 518 fps               |
| FPS  | Ombres tracées | 577 fps          | 182 fps               |
| FPS  | + reflets     | 308 fps           | 104 fps               |
| FPS  | Path tracer   | 106 fps           | 36 fps                |
| TPS  | Rastérisé     | 82 fps            | 61 fps                |
| TPS  | Ombres tracées | 47 fps           | 21 fps                |
| TPS  | + reflets     | 43 fps            | 19 fps                |
| TPS  | Path tracer   | 51 fps            | 22 fps                |

La forêt du TPS (des milliers de sapins) coûte surtout par la reconstruction de la TLAS sur le CPU à chaque image, et en WebGPU par la traversée logicielle. Le path tracer à 4 rebonds lance environ 20 dispatchs de matériaux par rebond dans le TPS.

## 10. Reportés

- Les meshes déformés sur le GPU (le skinning de P6, la mer de P17, la tessellation de P3b) : leurs BLAS sont ceux de la pose de repos ou absents ; la mise à jour (refit) depuis les buffers du calcul viendra ensuite.
- L'alpha testé pendant la traversée (le feuillage dans les ombres et l'occlusion) ; le path tracer le traite par des rebonds à travers.
- Les pipelines de ray tracing de Vulkan, DXR sur Direct3D 12, le BVH construit sur le GPU, les BVH à 4 enfants.
- SVGF, ReSTIR, l'échantillonnage des textures d'environnement par importance.

## 11. État

**Faite** (25 octobre 2026) : les BVH d'`engine-geometry`, l'API des structures d'accélération (`engine-backend`), leurs implémentations matérielle (`engine-vulkan`, la bibliothèque native) et logicielle (`engine-webgpu`), `ray.trace`, `std.bitcast`, les fonctions des impacts, le garde et la cible « impact » d'`engine-shader`, les rayons du `Renderer` (`rays`, `addFullscreenPass`, `addToneMappingPass`, `executeGraph`), `@fdw/engine-raytracing` (`RayScene`, `RayOcclusion`, `RayReflections`, `reflectionOutputs`, `PathTracer`), `RayView` et les quatre rendus du FPS et du TPS (menu, `--rays` en natif), le guide et les tutoriels.
