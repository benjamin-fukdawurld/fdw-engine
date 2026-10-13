# P2b : cibles multiples, sorties de surface, rendu différé, détails de surface

Le design de la phase P2b de la [roadmap](roadmap.md#p2b-cibles-de-rendu-multiples-rendu-différé-et-détails-de-surface). Le principe posé : **le moteur ne fixe aucune liste de cibles**. L'utilisateur choisit ce que ses passes écrivent (la couleur éclairée, des normales, des identifiants, n'importe quelle valeur de la surface) et compose les textures obtenues comme il veut dans le render graph. Le rendu différé n'est qu'une façon de les composer.

Contraintes : rien que WebGL2 ne puisse tenir (ou une capacité explicite quand il ne peut pas) ; le graphe d'un matériau ne change pas selon les cibles ; pas de surcoût pour qui n'en demande pas.

## 1. Aujourd'hui

| Couche                                           | Une seule cible ?                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API des backends (`colorAttachments`, `targets`) | Non : des listes                                                                                                                                                          |
| Render graph et runner                           | Non : `writeColor` répété, une résolution par attachment                                                                                                                  |
| WebGPU, Vulkan                                   | Non : tous les attachments et toutes les cibles sont transmis ; Vulkan limite à 8 et active `independentBlend` quand le GPU l'a                                           |
| **WebGL2**                                       | **Oui** : `beginRenderPass` refuse plus d'un attachment, `framebufferFor` n'attache que `COLOR_ATTACHMENT0`, une seule résolution, un mélange global (`targets[0].blend`) |
| **Compilateur et générateurs**                   | **Oui** : `output.fragment.color` est un `vec4f`, l'IR fixe `outputs = [{ color, location 0 }]`, les trois générateurs n'émettent que `outputs[0]`                        |
| **`Renderer`**                                   | **Oui** : une cible par pipeline ; `addScenePasses` rend un seul handle (la couleur) et garde la profondeur pour lui                                                      |
| Effacement des formats entiers                   | WebGL2 utilise `clearColor` (faux pour `r32uint`) ; Vulkan convertit en `uint32` même pour les formats signés                                                             |
| Relecture                                        | Seulement la surface entière (`readPixels`), pas une région d'une texture                                                                                                 |

Ce qui existe déjà et servira : les varyings entiers (`flat`), l'entrée `normal` des modèles phong et pbr, la macro `macro.normalMapping` (repère tangent depuis l'attribut `tangent`, sinon la normale du sommet), l'entrée `positionOffset` de `output.surface` (déplacement des sommets), `textureSampleLevel` dans le vertex stage, les mipmaps et l'anisotropie.

## 2. Les cibles multiples (MRT)

### 2.1 Dans le material graph et l'IR

| Option                                                                               | Intérêt                                                                           | Coût                                                                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **A. Des ports numérotés** sur `output.fragment` (`color`, `color1`… `color7`)       | Simple                                                                            | Type `vec4f` figé, pas de nom ; illisible au-delà de deux                                    |
| **B. Un nœud `output.target`** par sortie : `{ name, location }` et une valeur typée | Nommé, typé (`vec4f`, `vec4u`, `f32`, `u32`…), autant que voulu, validé un par un | Un nœud de plus ; la validation des sorties à revoir (un seul `output.fragment` aujourd'hui) |

**Recommandation : B.** `output.fragment.color` reste la sortie `location 0` (rien ne change pour les graphes existants) ; chaque `output.target` ajoute une sortie. L'IR généralise `outputs` en une liste `{ name, type, location }` remplie depuis ces nœuds, et `results` est déjà indexé par nom. Les générateurs émettent :

- **WGSL** : une structure de sortie (`struct FragmentOutputs { @location(0) color: vec4<f32>, @location(1) id: u32 }`) quand il y a plus d'une sortie, la forme actuelle sinon (snapshots inchangés) ;
- **GLSL ES** : une déclaration `layout(location = n) out` par sortie (`uvec4` / `uint` pour les entiers) ;
- **HLSL** : une structure avec `SV_Target{n}`.

Types acceptés : scalaires et vecteurs de `f32`, `u32`, `i32`. Le format de la cible doit correspondre (flottant/normalisé pour `f32`, `uint` pour `u32`) : vérifié à la création du pipeline. `CompilerVersion` augmente (les clés de programme changent).

### 2.2 Dans les backends

- **WebGL2** : `framebufferFor` prend une liste d'attachments (clé : la liste), appelle `drawBuffers([COLOR_ATTACHMENT0…n])`. Effacement attachment par attachment avec `clearBufferfv` / `clearBufferuiv` / `clearBufferiv` selon le format. Résolution du MSAA attachment par attachment (`readBuffer(COLOR_ATTACHMENTi)` et un framebuffer de destination à un attachment, puis `blitFramebuffer`).
- **Le mélange** : WebGL2 n'a qu'un état de mélange pour tous les attachments, sauf avec `OES_draw_buffers_indexed` (`blendFuncSeparateiOES`, `colorMaskiOES`). Le mélange est ignoré pour les formats entiers (spécification). Règle commune : une capacité `independentBlend` ; sans elle, un pipeline dont les cibles flottantes ont des mélanges différents est refusé avec un message clair. Le `Renderer` ne le demande jamais (§3.4).
- **Vulkan** : corriger l'effacement des formats signés (`int32`). Rien d'autre.
- **Capacités** : `maxColorAttachments` (WebGPU : `limits.maxColorAttachments`, 8 ; WebGL2 : `MAX_DRAW_BUFFERS`, au moins 4 ; Vulkan : `maxColorAttachments`, plafonné à 8) et `maxColorAttachmentBytesPerSample` (WebGPU : 32 octets, chaque format avec son coût et son alignement : `rgba16float` + `rgba16float` + `rgba8unorm` + `r32uint` = 28). Le `Renderer` vérifie avant de créer les pipelines.
- **Valeurs d'effacement** : `clearValue` reste un `IColor` ; pour une cible entière, ses composantes sont des entiers. Documenté.

### 2.3 La relecture d'une région

Pour la sélection, il faut lire quelques pixels d'une texture, sans bloquer la frame : `backend.textures.readTexture(texture, { x, y, width, height }): Promise<ArrayBuffer>`, rangées depuis le haut, premier niveau.

| Backend | Implémentation                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGPU  | `copyTextureToBuffer` (rangées alignées sur 256 octets, recopiées serrées), `mapAsync`                                                                                                         |
| WebGL2  | `readPixels` dans un PBO (`PIXEL_PACK_BUFFER`), une fence (`fenceSync`) sondée, puis `getBufferSubData` ; `RGBA_INTEGER` pour les formats entiers ; lignes inversées (stockage de bas en haut) |
| Vulkan  | La relecture native existante, étendue à une région                                                                                                                                            |

Les surfaces hors écran gardent `readPixels()`, réécrit sur ce mécanisme.

## 3. Les sorties de surface

### 3.1 Ce que l'utilisateur demande

`addScenePasses` reçoit les sorties voulues, **autant que l'application veut, nommées comme elle veut**, chacune avec un format et ce qu'elle contient :

```ts
// Une sortie décrite par l'application : une fonction-graphe dont les
// entrées sont nommées d'après les valeurs de la surface et du moteur.
const f = new GraphBuilder('material properties');
const roughness = f.functionInput('roughness', BuiltinTypes.f32);
const metallic = f.functionInput('metallic', BuiltinTypes.f32);
const occlusion = f.functionInput('occlusion', BuiltinTypes.f32);
f.functionOutput(
  'value',
  f.call(std.vec4, { x: roughness, y: metallic, z: occlusion, w: 1 })
);
const properties = defineFunction(f.build(), { id: 'app.properties' });

const scene = renderer.addScenePasses(graph, {
  items,
  camera,
  outputs: {
    color: { format: 'rgba16float' }, // la couleur éclairée, comme aujourd'hui
    normal: { format: 'rgba16float', value: 'view-normal' },
    depth: { format: 'r32float', value: 'view-depth' },
    id: { format: 'r32uint', value: 'object-id' },
    properties: { format: 'rgba8unorm', value: properties },
    velocity: { format: 'rg16float', value: 'material', default: [0, 0] },
  },
});
scene.outputs.normal; // TextureHandle, comme scene.outputs.properties, scene.depth
```

Ce que contient une sortie, trois façons de le dire :

1. **Une valeur fournie par le moteur**, un raccourci :

   | Valeur                                                                               | Ce qui est écrit                                                                                      |
   | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
   | `'color'` (par défaut pour la sortie `color`)                                        | La couleur éclairée, comme aujourd'hui                                                                |
   | `'view-normal'`, `'world-normal'`                                                    | La normale de la surface, après normal mapping (l'entrée `normal`, sinon celle du sommet), normalisée |
   | `'view-depth'`, `'world-position'`                                                   | La profondeur linéaire dans la vue, la position dans le monde                                         |
   | `'object-id'`                                                                        | L'identifiant de l'objet (§3.3)                                                                       |
   | `'base-color'`, `'alpha'`, `'emissive'`, `'roughness'`, `'metallic'`, `'occlusion'`… | L'entrée de la surface du même nom, ou sa valeur par défaut si le modèle ne l'a pas                   |

2. **Une fonction-graphe de l'application**, la même pour tous les matériaux : ses entrées sont reliées par leur nom aux valeurs de la surface et du moteur (`baseColor`, `alpha`, `normal`, `viewNormal`, `worldNormal`, `viewDepth`, `worldPosition`, `objectId`, `uv`, les entrées du modèle d'éclairage…), sa sortie est écrite. Une entrée au nom inconnu est une erreur qui liste les noms possibles. C'est ce qui permet de **ranger plusieurs valeurs dans une cible** (rugosité, métal et occlusion dans un `rgba8unorm`), d'encoder (normales en octaèdre), de calculer ce que le moteur ne connaît pas, sans toucher aux matériaux.
3. **`'material'`** : chaque matériau qui le veut écrit la sortie lui-même, par un nœud `g.output('velocity', valeur)` dans son graphe, relié par le nom ; les autres écrivent `default`. Pour ce qui dépend vraiment du matériau (une vitesse d'animation, un masque d'effet, un identifiant de matériau).

**Sans sortie `color`, pas d'éclairage** : le compilateur n'appelle pas le modèle d'éclairage. C'est la passe G-buffer d'un rendu différé (§4), et une passe bon marché pour des normales ou des identifiants seuls.

### 3.2 Dans le compilateur

Une feature `outputs` (statique, dans la clé de variante) : la liste `{ name, type, value }`, les fonctions-graphes désignées par leur `id` et fournies au compilateur avec les autres fonctions. La lowering de `output.surface` produit `output.fragment.color` si `color` est demandée, et un `output.target` par autre sortie : la valeur du moteur, l'appel de la fonction-graphe (inlinée, comme toutes les fonctions-graphes, sur les valeurs de la surface) ou la valeur du nœud `g.output` (`output.value`) du matériau. C'est la cible `gbuffer` prévue au [render graph §8](render-graph.md#8-les-matériaux-dans-les-passes), généralisée à une liste choisie par l'utilisateur. Une valeur que la passe ne demande pas n'est pas calculée (le nœud `g.output` d'un matériau est ignoré hors des passes qui ont la sortie).

Les normales dans la vue demandent `camera.view` (déjà une valeur du moteur). La bibliothèque standard fournira l'encodage et le décodage en octaèdre (`rg16float`, deux fois moins de bande passante qu'un `rgba16float`), utilisables dans une fonction-graphe de sortie et dans les passes qui la lisent.

### 3.3 L'identifiant des objets

`RenderItem.id` et `node.id` (un nombre ≥ 1, 0 voulant dire « rien »). Où le stocker :

| Option                                                                                                | Intérêt                                                                                       | Coût                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Un flottant dans le remplissage de la ligne** (le `.w` de la première colonne de `normalMatrix`) | Aucune place en plus, ligne de 112 octets inchangée, lecture identique sur les trois backends | Exact jusqu'à 2^24 (16,7 millions d'objets) ; la recopie des blocs du pool de transforms écrit 0 à cet endroit : la ligne est complétée après la copie               |
| B. Les bits d'un `u32` dans ce même flottant (`bitcast`)                                              | 2^32 identifiants                                                                             | Les petits entiers sont des flottants **dénormaux** : risque de mise à zéro par les GPU et par les textures de données RGBA32F de WebGL2 ; à proscrire               |
| C. Un membre `u32` de plus dans la ligne                                                              | Propre, 2^32                                                                                  | La ligne passe à 128 octets et ne se recopie plus telle quelle depuis le pool de transforms ; WebGL2 lit ses lignes dans une texture RGBA32F (même problème qu'en B) |

**Choix : A.** 16,7 millions d'identifiants suffisent même aux grosses maquettes BIM. Au-delà, la sélection passe par le lancer de rayons sur la scène (`scene.raycast`, BVH) plutôt que par le buffer d'identifiants : la documentation le dira. L'instancing garde l'identifiant (il vient de la ligne), et les matériaux masqués respectent leur `discard`.

**La sélection** : un utilitaire `pickIds(backend, texture, rect)` relit la région (§2.3) et rend les identifiants distincts trouvés (un clic : un pixel ; un rectangle de sélection : la région). Il est asynchrone : une ou deux frames de latence, sans bloquer la boucle.

### 3.4 Les règles qui gardent l'ensemble simple

- **Les transparents n'écrivent que la couleur.** Leur passe n'attache que la cible `color` (et la profondeur en lecture) : pas de mélange de normales ou d'identifiants, ce qui n'aurait pas de sens, et pas besoin de mélange par attachment en WebGL2. Un objet de verre n'est donc pas sélectionnable au pixel ; une option `transparentIds` écrira plus tard ceux dont l'alpha dépasse un seuil, dans une passe à part.
- **MSAA** : toutes les sorties d'une passe ont le même nombre d'échantillons ; les sorties flottantes sont résolues (les normales sont moyennées sur les bords, ce qui reste acceptable : les passes les renormalisent), **les sorties entières ne peuvent pas l'être** (WebGPU refuse leur résolution). Une sortie entière avec `samples > 1` est donc refusée avec un message clair. Pour combiner MSAA et identifiants : `samples` devient une option de chaque `addScenePasses` (le défaut reste celui du `Renderer`), et l'application ajoute une passe d'identifiants à un échantillon, éventuellement seulement quand elle en a besoin (au clic).
- **La profondeur** : `addScenePasses` rend aussi `depth`, et accepte une `depth` existante (`load` au lieu de `clear`), pour enchaîner des passes sur la même profondeur (G-buffer puis transparents, pré-passe de profondeur). Lire la profondeur dans un shader reste réservé aux shadow maps pour l'instant : les effets lisent `view-depth`.

### 3.5 Le changement d'API

`addScenePasses` rend aujourd'hui un `TextureHandle`. Il rendra `{ color?, depth, outputs }`. Peu d'appelants (le `Renderer`, la suite de rendu, deux exemples de la doc) : un changement cassant, plutôt qu'une seconde méthode qui ferait presque la même chose.

## 4. Le rendu différé

Pas de mode du moteur : une composition, documentée par un exemple.

1. `addScenePasses` sans sortie `color`, avec les sorties du G-buffer choisies par l'application (par exemple `base-color`, `view-normal`, rugosité et métal rangés dans une même cible par une fonction-graphe de sortie, `emissive`, `world-position` ou `view-depth`), en ne gardant que les objets opaques (option `include: 'opaque'`).
2. Une passe plein écran écrite en material graph qui lit ces textures et éclaire : les modèles d'éclairage deviennent appelables comme des fonctions dans un graphe plein écran (ils ne dépendent que de leurs entrées et des lumières de la frame), avec la position du monde lue ou reconstruite. À ajouter : la valeur `camera.inverseViewProjection` pour la reconstruction depuis `view-depth`, et l'accès aux lumières de la frame dans les passes plein écran (leurs uniforms de frame sont ceux de la dernière scène : à vérifier et tester).
3. `addScenePasses` avec `include: 'transparent'` et la profondeur du G-buffer : les transparents en forward par-dessus.

Ce qu'il faudra documenter : la bande passante (quatre cibles `rgba16float` en 1080p : 66 Mo écrits puis relus par frame), l'incompatibilité pratique avec le MSAA, et le gain réel, qui n'arrive qu'avec beaucoup de lumières : le culling en clusters de P2 en fera un vrai choix.

## 5. Les détails de surface

| Technique                | Ce qu'il faut                                                                                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dérivées**             | `std.dpdx`, `std.dpdy`, `std.fwidth` (fragment seulement ; `dpdx`/`dFdx`/`ddx`), base du reste                                                                                                                                                                                                 |
| **Normal mapping**       | Existe (`macro.normalMapping`) avec l'attribut `tangent`. À ajouter : le calcul des tangentes sur le CPU (`computeTangents(mesh)`) et, sans tangentes, un repère calculé par les dérivées d'écran (cotangent frame) au lieu de la normale du sommet                                            |
| **Bump mapping**         | `std.bumpNormal(height, scale)` : la normale perturbée par les dérivées d'écran de la hauteur (Mikkelsen, 2010), sans tangentes ni uv particuliers                                                                                                                                             |
| **Parallax mapping**     | `std.parallaxUv(heightMap, uv, viewDirection, scale)` (décalage simple), puis le parallax occlusion mapping. Sans boucle générique dans le graphe : **une boucle déroulée à la compilation** par une macro au nombre de pas statique (8 à 32), plutôt que d'attendre `fold`                    |
| **Displacement mapping** | `positionOffset` existe : `std.displace(heightMap, uv, scale)` le long de la normale, lu par `textureSampleLevel` dans le vertex stage ; les normales recalculées par le bump de la même hauteur ; des maillages subdivisés (plan, sphère) dans `demo-scenes`. Adaptatif en P3b (tessellation) |

Un piège déjà rencontré, à documenter avec ces fonctions : `textureSampleLevel` avec un uv par sommet s'exécute dans le vertex stage ; il faut passer l'uv par `std.perFragment` pour échantillonner par pixel.

## 6. Les exemples de la documentation

Chacun avec sa page (EN, FR), son exemple vivant et ses captures de référence en WebGL2 et WebGPU :

- **Cibles multiples** : les sorties d'une scène affichées côte à côte (couleur, normales, profondeur, identifiants en fausses couleurs).
- **Occlusion ambiante** (SSAO) : normales et profondeur, une passe plein écran, un flou, la composition.
- **Sélection** : clic et rectangle, l'objet survolé en surbrillance.
- **Rendu différé** : beaucoup de petites lumières (dans la limite actuelle de 16, puis davantage avec P2).
- **Transparence** : `blend` et `mask`, le tri et ses limites, les objets double face.
- **Réflexion** : une cubemap d'environnement (`reflect`, le niveau de mipmap choisi par la rugosité ; il faut ajouter l'échantillonnage des textures `cube` dans la bibliothèque standard), un miroir plan (rendu dans une texture avec la caméra symétrique), des reflets en espace écran (normales et profondeur).
- **Normal, bump, parallax et displacement mapping** : la même surface avec les quatre techniques.

## 7. Les étapes

| Étape                                | Contenu                                                                                                                                                                             | Tests                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. MRT**                           | `output.target`, IR et trois générateurs ; WebGL2 (framebuffers, `drawBuffers`, effacements, résolutions, mélange) ; capacités ; effacements entiers                                | Snapshots des générateurs ; DXC, glslang, Tint en CI ; suite de rendu : un graphe brut qui écrit deux cibles, relues par une passe plein écran, sur les trois backends |
| **2. Sorties de surface**            | Feature `outputs` : valeurs du moteur, fonctions-graphes de sortie, `g.output` des matériaux ; sortie `color` facultative, nouvelle forme de retour, `samples` et `depth` par appel | Compilateur (variantes, programmes sans éclairage) ; `Renderer` (faux backend) ; suite de rendu : normales et profondeur vérifiées                                     |
| **3. Identifiants et sélection**     | `id` dans la ligne d'objet, `readTexture` d'une région, `pickIds`                                                                                                                   | Identifiants relus sur les trois backends, avec instancing et matériaux masqués                                                                                        |
| **4. Exemples MRT, SSAO, sélection** | Pages et exemples                                                                                                                                                                   | Captures de référence                                                                                                                                                  |
| **5. Rendu différé**                 | `include`, modèles d'éclairage dans les graphes plein écran, `camera.inverseViewProjection`, lumières en plein écran ; exemple                                                      | Même image en différé et en forward (à la tolérance près)                                                                                                              |
| **6. Détails de surface**            | Dérivées, tangentes, bump, parallax (déroulé), displacement ; exemples                                                                                                              | Compilateur ; rendu : une normale perturbée attendue en un pixel                                                                                                       |
| **7. Transparence et réflexion**     | Échantillonnage `cube`, exemples                                                                                                                                                    | Captures de référence                                                                                                                                                  |

Les étapes 1 à 3 forment le socle ; 4 à 7 peuvent s'ordonner librement ensuite.

## 8. Décisions

Validées le 13 octobre 2026 :

1. **L'identifiant en flottant**, limité à 2^24 (16,7 millions). Au-delà, le lancer de rayons ; documenté (§3.3).
2. **Le retour de `addScenePasses` change de forme** : un changement cassant, à condition de corriger tous les usages de l'ancienne API, dans le code, les exemples et la documentation (§3.5).
3. **Les transparents n'écrivent que la couleur** : une limite à documenter (pas de sélection au pixel du verre) ; **les sorties entières refusées en MSAA** (§3.4).
4. **Des sorties décrites par l'application**, nommées librement, par une fonction-graphe commune ou par le matériau, plutôt qu'une seule valeur « custom » (§3.1).
