# Render graph

_Statut : design validé dans ses grandes lignes (08/10/2026), à implémenter. Voir aussi le [compute graph](compute-graph.md), qui en est le complément._

Ce document décrit le **render graph** : son but, son intérêt, son coût, les alternatives, et le design retenu pour FdwEngine.

---

## Sommaire

1. [Résumé](#1-résumé)
2. [Le problème](#2-le-problème)
3. [But et intérêt](#3-but-et-intérêt)
4. [Coût](#4-coût)
5. [Alternatives](#5-alternatives)
6. [Design : ressources et passes](#6-design--ressources-et-passes)
7. [Design : compilation et exécution](#7-design--compilation-et-exécution)
8. [Les matériaux dans les passes](#8-les-matériaux-dans-les-passes)
9. [Les post-traitements](#9-les-post-traitements)
10. [Le Renderer sur le render graph](#10-le-renderer-sur-le-render-graph)
11. [Extensions de l'API abstraite](#11-extensions-de-lapi-abstraite)
12. [Compatibilité avec le ray tracing](#12-compatibilité-avec-le-ray-tracing)
13. [Plan d'implémentation](#13-plan-dimplémentation)
14. [Stratégie de test](#14-stratégie-de-test)
15. [Risques et décisions](#15-risques-et-décisions)

---

## 1. Résumé

- Une frame est décrite comme un **graphe de passes** (rendu, calcul, copie, plein écran, plus tard ray tracing) qui **déclarent** les ressources (textures, buffers) qu'elles lisent et écrivent, et comment.
- À partir de ces déclarations, le moteur **supprime les passes inutiles**, les **ordonne**, **alloue et réutilise** les ressources temporaires, et calcule la **synchronisation** dont les API explicites (Vulkan, Direct3D 12) ont besoin.
- Le graphe est **reconstruit à chaque frame**, et sa compilation est **mise en cache** tant que sa structure ne change pas.
- Les matériaux ne décrivent que leur surface : chaque passe choisit une **cible de compilation** (`forward`, `depth-only`, plus tard `bsdf` pour le ray tracing).
- Le `Renderer` actuel devient une **technique** construite sur le graphe, avec la même API ; il gagne une cible HDR, le tone mapping en passe de post-traitement (transparents exacts) et le multi-échantillonnage.

---

## 2. Le problème

### 2.1 Comment une frame est rendue aujourd'hui

Le `Renderer` fait **une seule passe de rendu** : il efface la surface et sa profondeur, dessine les objets opaques puis les transparents, et soumet. Tout est écrit à la main dans sa méthode `render()` :

- la texture de profondeur est créée et redimensionnée par le `Renderer` lui-même ;
- le tone mapping et l'encodage sRGB sont faits dans le shader de chaque matériau (l'option B du [§17.6 du material graph](material-graph.md#176-gestion-des-couleurs-et-tone-mapping)), donc avant le mélange des transparents, ce qui est légèrement faux ;
- aucune passe ne peut lire le résultat d'une autre : les cibles de rendu (`GpuRenderTarget`) ne sont pas des textures échantillonnables.

### 2.2 Ce qu'on veut rendre ensuite

Presque tous les effets d'un moteur moderne demandent **plusieurs passes** qui se passent des images :

| Effet                                 | Passes                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Ombres                                | une passe de profondeur par lumière (shadow map), lue par la passe d'éclairage |
| HDR et tone mapping exacts            | rendu dans une image haute précision, puis passe plein écran de tone mapping   |
| Post-traitements (flou, bloom, FXAA…) | une ou plusieurs passes plein écran qui lisent l'image précédente              |
| Multi-échantillonnage                 | rendu dans une cible multi-échantillonnée, puis résolution                     |
| Pré-passe de profondeur               | une passe de profondeur seule, pour ne pas calculer les pixels cachés          |
| Culling des lumières                  | une passe de calcul qui remplit une liste, lue par la passe d'éclairage        |
| Ray tracing                           | construction des structures d'accélération, passe de rayons, composition       |

### 2.3 Pourquoi c'est difficile à la main

Écrire ces passes une par une dans le `Renderer` fonctionne pour deux ou trois passes, puis devient fragile :

- **L'ordre** : chaque passe doit venir après celles qui produisent ce qu'elle lit. Ajouter un effet oblige à relire toute la séquence.
- **Les ressources temporaires** : qui crée la shadow map, quand la libérer, comment la réutiliser à la frame suivante, que faire au redimensionnement ? Chaque effet réinvente la réponse.
- **Les effets désactivés** : sans ombres, la passe d'ombres et sa texture ne doivent pas exister. Chaque option ajoute des conditions.
- **La synchronisation** : sur Vulkan et Direct3D 12, le GPU doit être prévenu avant qu'une image écrite par une passe soit lue par la suivante (une **barrière**). WebGPU le fait automatiquement ; les API explicites, non. Une barrière oubliée donne des artefacts aléatoires, une barrière en trop coûte des performances. C'est la principale source de bugs des moteurs Vulkan.

---

## 3. But et intérêt

Le render graph fait de la frame une **donnée** : une liste de passes et de ressources avec leurs dépendances. Le moteur peut alors raisonner sur la frame entière avant de l'exécuter.

| Intérêt                      | Ce que ça apporte                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Ordre automatique**        | les passes sont ordonnées par leurs dépendances ; ajouter un effet ne demande pas de relire les autres                            |
| **Culling**                  | une passe dont personne ne lit le résultat n'est pas exécutée : désactiver une option revient à ne plus lire sa sortie            |
| **Ressources gérées**        | les textures et buffers temporaires sont créés, réutilisés et libérés par le moteur                                               |
| **Synchronisation calculée** | les barrières des API explicites sont déduites des usages déclarés : le même graphe est correct sur WebGPU, Vulkan et Direct3D 12 |
| **Composition**              | des effets écrits indépendamment (ombres, bloom, culling) se combinent dans un même graphe                                        |
| **Diagnostic**               | le graphe peut être affiché, inspecté, mesuré passe par passe                                                                     |
| **Portabilité**              | les passes sont décrites par des usages abstraits, chaque backend les traduit                                                     |

C'est l'architecture des moteurs récents : le _frame graph_ de Frostbite (EA, 2017), le _Render Dependency Graph_ d'Unreal Engine, le _render graph_ d'Unity (SRP). C'est aussi la condition pour écrire un backend Vulkan ou Direct3D 12 correct sans dupliquer la synchronisation dans chaque effet.

---

## 4. Coût

| Coût                                                                                                         | Ampleur                                                                                                                                 | Mitigation                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **CPU par frame** : déclarer le graphe (quelques dizaines d'objets JavaScript), calculer sa clé structurelle | Faible : de l'ordre de la dizaine de microsecondes pour quelques dizaines de passes, négligeable devant l'enregistrement des draw calls | Cache de la compilation (§7.5) ; mesures dès l'étape RG3                                                                |
| **Compilation** quand la structure change (ordre, durées de vie, transitions)                                | Rare : au démarrage, au redimensionnement, quand une option change                                                                      | Cache par clé structurelle                                                                                              |
| **Mémoire** : le pool garde des ressources entre les frames                                                  | Les ressources d'une frame, gardées pour la suivante (ce qu'on ferait de toute façon)                                                   | Destruction des ressources non réutilisées pendant quelques frames                                                      |
| **Complexité du moteur** : un compilateur de graphe, un pool, des transitions                                | Un module de plus dans `engine-core`, testable seul sur le faux backend                                                                 | Tests unitaires de l'ordre, du culling, des transitions                                                                 |
| **Indirection** : une passe s'exécute plus tard que sa déclaration, ce qui rend le débogage moins direct     | Réelle, surtout au début                                                                                                                | Noms de passes et de ressources dans les labels GPU (visibles dans les outils de capture) ; affichage du graphe compilé |
| **Discipline** : une passe doit déclarer toutes ses ressources                                               | C'est aussi ce qui rend la synchronisation automatique                                                                                  | Erreurs claires à l'exécution quand une passe utilise une ressource non déclarée                                        |

---

## 5. Alternatives

| Alternative                                                             | Principe                                                                                                                       | Avantages                                                                                                                                                        | Inconvénients                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Passes écrites à la main** (statu quo étendu)                      | le `Renderer` enchaîne lui-même ses passes, crée ses textures, émet ses barrières                                              | aucun mécanisme nouveau ; le plus rapide à écrire pour deux passes                                                                                               | ordre, ressources, options et barrières gérés à la main dans chaque effet ; ne passe pas à l'échelle ; chaque technique réinvente tout                                                               |
| **B. Graphe déclaré une fois** (« retenu »)                             | le graphe est construit au démarrage ; les options l'activent ou le désactivent ; il est reconstruit quand la structure change | pas de déclaration par frame                                                                                                                                     | il faut décrire les variations (passes conditionnelles, nombre variable de shadow maps) avec des mécanismes d'activation et d'invalidation ; API plus lourde ; logique de mise à jour source de bugs |
| **C. Graphe reconstruit à chaque frame, compilation en cache** (retenu) | la frame se décrit comme du code, à chaque frame ; la compilation est réutilisée tant que la structure ne change pas           | les options se lisent comme du code ordinaire (`if (shadows) addShadowPass(…)`) ; nombre de passes variable sans effort ; le choix de Frostbite, Unreal et Unity | une déclaration par frame (coût faible, §4)                                                                                                                                                          |
| **D. Bibliothèque existante**                                           | utiliser un render graph tiers                                                                                                 | pas d'écriture                                                                                                                                                   | aucune en TypeScript qui soit indépendante de l'API graphique ; dépendance au cœur du moteur                                                                                                         |

**Décision : C.** Le surcoût par frame est faible et mesurable, et la simplicité pour l'utilisateur est déterminante : la frame se lit comme le code qui la décrit.

**Le compute graph n'est pas concerné** par ce choix : un compute graph est un programme, compilé une fois et mis en cache comme un matériau ; c'est sa **passe de calcul** qui est déclarée à chaque frame dans le render graph.

---

## 6. Design : ressources et passes

### 6.1 Ressources

Une ressource du graphe est un **handle virtuel** : elle n'existe sur le GPU qu'à l'exécution, si une passe conservée s'en sert.

```ts
type TextureSize =
  | { readonly width: number; readonly height: number }
  // Relative to the surface: 1 for full resolution, 0.5 for half…
  | { readonly relative: number };

interface GraphTextureDescriptor {
  readonly format: GpuTextureFormat;
  readonly size: TextureSize;
  readonly mipLevels?: number;
  readonly samples?: number;
  readonly label?: string;
}

interface GraphBufferDescriptor {
  readonly size: number;
  readonly label?: string;
}
```

| Origine                                          | Exemples                                                         | Durée de vie                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- |
| **Temporaire** (`createTexture`, `createBuffer`) | cible HDR, profondeur, shadow map, liste de lumières             | la frame ; réutilisée par le pool à la frame suivante |
| **Importée** (`importTexture`, `importBuffer`)   | image de la surface, buffers de la scène, textures des matériaux | gérée hors du graphe                                  |
| **Persistante** (`createPersistentTexture`)      | historique du TAA, exposition adaptative                         | plusieurs frames, gardée par le graphe                |

**Versions.** Chaque écriture crée une **nouvelle version** de la ressource, comme une valeur SSA dans le compilateur de matériaux : `hdr` écrit par la passe des opaques puis par celle des transparents donne `hdr#1` puis `hdr#2`. Une passe lit une version précise : les dépendances sont sans ambiguïté, et une lecture avant toute écriture est détectée.

### 6.2 Usages

Une passe déclare **comment** elle utilise chaque ressource. Ces usages servent aux dépendances, aux flags de création (WebGPU exige les usages d'une texture à sa création) et aux transitions des API explicites.

| Usage                                                         | Ressource                | Lecture / écriture                              |
| ------------------------------------------------------------- | ------------------------ | ----------------------------------------------- |
| `color-attachment`                                            | texture                  | écriture (lecture-écriture avec `load`)         |
| `depth-attachment`                                            | texture                  | écriture, ou lecture seule (test sans écriture) |
| `sampled`                                                     | texture                  | lecture                                         |
| `storage-read`, `storage-write`                               | texture ou buffer        | lecture, écriture                               |
| `uniform`                                                     | buffer                   | lecture                                         |
| `vertex`, `index`, `indirect`                                 | buffer                   | lecture                                         |
| `copy-src`, `copy-dst`                                        | texture ou buffer        | lecture, écriture                               |
| `resolve`                                                     | texture                  | écriture (résolution du multi-échantillonnage)  |
| `acceleration-structure-build`, `acceleration-structure-read` | structure d'accélération | plus tard (§12)                                 |

### 6.3 Types de passes

| Type                                    | Rôle                                                                          | Disponible sur                        |
| --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `raster`                                | dessiner dans des attachments couleur et profondeur                           | tous les backends                     |
| `fullscreen`                            | un triangle plein écran avec un programme de fragment : post-traitements (§9) | tous                                  |
| `compute`                               | exécuter un [compute graph](compute-graph.md) compilé                         | WebGPU, natifs ; **pas WebGL2** (§15) |
| `copy`                                  | copies entre buffers et textures, génération de mipmaps                       | tous                                  |
| `ray-tracing`, `acceleration-structure` | plus tard (§12)                                                               | natifs avec capacité                  |

Le type d'une passe détermine l'encodeur ouvert pour elle ; le graphe ne fait aucune autre hypothèse, en particulier pas « un draw par objet ».

### 6.4 Construction

Le graphe se construit en trois phases : **déclaration** (les passes déclarent ressources et usages), **compilation** (§7), **exécution** (les passes conservées enregistrent leurs commandes). La fonction de déclaration d'une passe rend sa fonction d'exécution, appelée seulement si la passe est conservée, avec les ressources réelles.

```ts
const graph = new RenderGraph();

const backbuffer = graph.importTexture(
  'backbuffer',
  surface.getCurrentTarget()
);
const hdr = graph.createTexture('hdr', {
  format: 'rgba16float',
  size: { relative: 1 },
});
const depth = graph.createTexture('depth', {
  format: 'depth24plus',
  size: { relative: 1 },
});

const opaque = graph.addRasterPass('opaque', (pass) => {
  pass.writeColor(hdr, { load: 'clear', clearValue: black });
  pass.writeDepth(depth, { load: 'clear', clearValue: 1 });
  return (context) => context.drawScene(view, { queue: 'opaque' });
});

const transparent = graph.addRasterPass('transparent', (pass) => {
  pass.writeColor(opaque.color, { load: 'load' });
  pass.readDepth(opaque.depth); // test sans écriture
  return (context) => context.drawScene(view, { queue: 'transparent' });
});

graph.addFullscreenPass('tone mapping', {
  program: toneMapping,
  inputs: { hdr: transparent.color },
  output: backbuffer,
});

graph.execute(backend);
```

### 6.5 Effets de bord

Une passe dont personne ne lit les sorties est supprimée. Une passe qui doit s'exécuter quand même (capture, lecture de pixels) le déclare (`pass.hasSideEffects()`) ; écrire dans une ressource importée compte comme un effet de bord.

---

## 7. Design : compilation et exécution

### 7.1 Culling

À partir des passes à effets de bord et de celles qui écrivent des ressources importées, le compilateur remonte les dépendances. Les autres passes sont supprimées, avec les ressources qu'elles seules utilisaient.

### 7.2 Ordre

Les passes conservées sont ordonnées **topologiquement** selon les versions des ressources ; à dépendances égales, l'**ordre de déclaration** est gardé. L'ordre est déterministe et prévisible.

### 7.3 Ressources temporaires

Pour chaque ressource temporaire : la **première et la dernière passe** qui s'en servent, et l'**union de ses usages**.

- **Pool** : à l'exécution, le pool fournit une ressource de même descripteur et de mêmes usages, libérée par une frame précédente, ou en crée une. Les ressources non réutilisées pendant quelques frames sont détruites.
- **Taille relative** : `{ relative: 1 }` suit la taille de la surface ; un redimensionnement change le descripteur.
- **Aliasing** (plus tard) : deux ressources aux durées de vie disjointes peuvent partager la même mémoire, sur les backends à tas explicites (Vulkan, Direct3D 12).

### 7.4 Synchronisation

Le compilateur connaît la suite des usages de chaque ressource : il calcule les **transitions** entre les passes (de `color-attachment` à `sampled`, de `storage-write` à `storage-read`…).

- **WebGPU, WebGL2** : synchronisation implicite, les transitions ne sont pas émises.
- **Vulkan, Direct3D 12** : le backend les traduit en barrières (layouts d'image, états de ressources) avant chaque passe.

### 7.5 Cache de compilation

La compilation (culling, ordre, durées de vie, transitions) est mise en cache par une **clé structurelle** : passes, types, ressources, descripteurs, usages. Tant que la structure de la frame ne change pas, seule la déclaration est refaite, pas la compilation.

### 7.6 Exécution

Pour chaque passe conservée, dans l'ordre : allouer les ressources qui commencent, émettre les transitions, ouvrir l'encodeur du type de la passe, appeler sa fonction d'exécution, fermer l'encodeur, rendre au pool les ressources qui finissent. Toute la frame est enregistrée dans un encodeur de commandes et soumise une fois.

---

## 8. Les matériaux dans les passes

Avec plusieurs passes, un même matériau est compilé **selon la passe** qui le dessine. La passe choisit une **cible de compilation**, passée comme feature (comme `alphaMode` aujourd'hui) et lue par la lowering de `output.surface` :

| Cible                 | Ce que le compilateur produit                                                         | Utilisée par                    |
| --------------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `forward`             | surface → modèle d'éclairage → couleur linéaire (aujourd'hui)                         | passes opaques et transparentes |
| `depth-only`          | la position seule (et le test d'alpha des matériaux masqués), sans modèle d'éclairage | ombres, pré-passe de profondeur |
| `gbuffer` (plus tard) | les entrées de la surface dans plusieurs attachments                                  | rendu différé                   |
| `bsdf` (plus tard)    | surface et modèle d'éclairage en fonctions d'évaluation et de tirage                  | ray tracing                     |

Le graphe du matériau ne change pas : c'est la séparation surface / éclairage ([évolutions §3](evolutions.md#3-contraintes-de-compatibilité-pour-les-prochaines-étapes)). Le paramètre `shadowPass` des [écarts du material graph](material-graph-gaps.md) est couvert par la cible `depth-only`.

---

## 9. Les post-traitements

### 9.1 Ce que le material graph permet déjà

Le langage du material graph sait **presque** écrire un post-traitement : les sorties brutes `output.vertex` / `output.fragment`, le builtin `vertex-index` et `textureSample` suffisent pour un triangle plein écran qui lit une texture. Ce qui manque n'est pas dans le langage, mais autour :

| Manque                                                                                                                                                                           | Nature                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Lire le résultat d'une passe précédente** : les cibles de rendu ne sont pas des textures échantillonnables                                                                     | **Limitation réelle du runtime**, levée par les textures à usages (§11.1) |
| **Dessiner sans mesh** : le `Renderer` ne dessine que des `RenderItem` avec un mesh                                                                                              | **Limitation réelle du runtime**, levée par les passes `fullscreen`       |
| **Coordonnées d'écran portables** : `frag-coord` a son origine en haut à gauche en WGSL, en bas à gauche en GLSL (écart connu), et il faut la taille de la cible pour normaliser | **Limitation de portabilité**, levée par un builtin `screen-uv`           |
| **Écrire le vertex stage plein écran** à chaque fois (calcul des positions depuis `vertex-index`)                                                                                | **Confort** (UX)                                                          |

### 9.2 Ce qui est proposé

- Une sortie **`output.fullscreen`** : le compilateur génère le vertex stage (un triangle couvrant la cible, sans mesh) ; le graphe ne décrit que la couleur.
- Un builtin **`screen-uv`** : les coordonnées normalisées dans la cible, origine en haut à gauche sur tous les backends.
- Des **passes `fullscreen`** dans le render graph, qui lient les textures d'entrée du programme aux ressources du graphe.

Les post-traitements sont donc des material graphs comme les autres, avec la même bibliothèque, les mêmes fonctions et les mêmes nœuds de couleur (`color.toneMapAces`, `color.linearToSrgb`).

```ts
const g = new GraphBuilder('tone mapping');
const hdr = g.call(std.textureSampleLevel, {
  texture: g.texture('hdr'),
  sampler: g.sampler('hdrSampler'),
  uv: g.builtin('screen-uv'),
  level: 0,
});
const mapped = g.call('color.toneMapAces', {
  color: g.call(std.mul, { a: hdr.swizzle('rgb'), b: g.engine('exposure') }),
});
g.fullscreen({
  color: g.call(std.extend, {
    xyz: g.call('color.linearToSrgb', { color: mapped }),
    w: 1,
  }),
});
```

---

## 10. Le Renderer sur le render graph

### 10.1 Pour l'utilisateur

`renderer.render({ items, camera, surface, lights, exposure })` reste l'API courante. En interne, le `Renderer` construit un graphe à chaque frame : c'est une **technique** (le rendu forward), et d'autres pourront s'écrire de la même façon. Un utilisateur avancé construit son propre graphe et y ajoute des passes du `Renderer`.

### 10.2 La vue de scène

Les passes reçoivent une **vue de scène** : les objets visibles depuis une caméra, regroupés par file (`opaque`, `masked`, `transparent`) et triés. Elle fournit les données de la scène sous deux formes :

- **par objet**, comme aujourd'hui : un uniform par objet, un draw call par objet ;
- **en tables** (plus tard) : un storage buffer de toutes les instances (transformations, identifiants de matériaux), et les matériaux dans des buffers indexés. C'est ce qu'il faut pour le rendu piloté par le GPU, le culling des lumières et le ray tracing ([évolutions §3, point 4](evolutions.md#3-contraintes-de-compatibilité-pour-les-prochaines-étapes)).

### 10.3 Le graphe de la technique forward

```
  [optionnel] culling des lumières (compute)
            │
  opaques et masqués ──► hdr (rgba16float), depth
            │
  transparents (load hdr, profondeur en lecture)
            │
  tone mapping (fullscreen) ──► surface
```

- La cible **HDR** reçoit la couleur linéaire ; les **transparents se mélangent en linéaire**, avant le tone mapping : c'est exact.
- La passe de **tone mapping** applique l'exposition, l'opérateur et l'encodage : l'**option C** du [§17.6 du material graph](material-graph.md#176-gestion-des-couleurs-et-tone-mapping). Les matériaux n'ont plus de variantes par opérateur.
- La **profondeur** devient une ressource temporaire du graphe.
- Le **multi-échantillonnage** devient possible : cible HDR multi-échantillonnée, résolue avant le tone mapping.
- Sans format `rgba16float` rendable, le `Renderer` revient au rendu direct dans la surface (option B actuelle).

### 10.4 Les ombres

Premier effet multi-passes : une passe `depth-only` par lumière qui projette des ombres, dans une texture lue par les passes d'éclairage. Le modèle d'éclairage lit la visibilité de la lumière courante (`light.current` gagne une sortie), sans changement des graphes des matériaux.

Ce qui a été implémenté (RG5) :

- **Un atlas** : les shadow maps des lumières partagent une texture de profondeur (`shadowAtlasSize`, 2048 par défaut), découpée en tuiles égales (grille de ⌈√n⌉ colonnes). Une seule passe `<scène> shadows` la remplit : un viewport par tuile (`setViewport`, nouvelle méthode de l'API abstraite), une vue (uniforms de frame) par lumière. Une seule ressource du graphe, une seule texture à lier, des tuiles indexées dans la boucle de lumières.
- **Les lumières** : `DirectionalLight` et `SpotLight` ont `castShadow` et `shadow` (`bias`, `normalBias`, `bounds`). Les lumières ponctuelles n'en projettent pas encore (il faudrait six faces). Un `RenderItem` peut refuser de projeter (`castShadow: false`) ; les transparents ne projettent pas.
- **Le cadrage** : une lumière directionnelle couvre la sphère englobante des objets (ou `shadow.bounds`) en projection orthographique ; son centre se déplace par texels entiers, pour que les ombres ne scintillent pas quand la scène bouge. Un spot couvre son cône (plus une marge pour le filtrage) en perspective, ses plans proche et lointain encadrent la scène.
- **Les matériaux** : la variante `depthOnly` (feature) n'écrit pas de couleur (sortie `output.fragment` sans `color`, passe sans attachment de couleur) et ne garde que le test des matériaux masqués. La feature `shadows`, donnée par le `Renderer` quand une lumière projette, fait lire l'atlas par la macro `light.shadow` des modèles phong et pbr : sans elle, la visibilité vaut 1 et ne coûte rien.
- **Le shader** : `light.current` gagne `shadow` (activée, biais, décalage normal, taille d'un texel), `shadowRect` (la tuile) et `shadowMatrix` (un `mat4` par lumière). L'atlas et son sampler de comparaison sont des ressources du moteur dans le groupe `frame` (`input.engine` `shadowMap` et `shadowSampler`), présentes seulement dans les programmes qui les lisent. La comparaison est un nouveau nœud, `std.textureSampleCompare` (`textureSampleCompareLevel` en WGSL, `sampler2DShadow` en GLSL, utilisable dans la boucle de lumières). 3 × 3 comparaisons filtrées chacune sur 2 × 2 texels adoucissent les bords (PCF).
- **L'acné** : décalage du point le long de sa normale (`normalBias` en texels, proportionnel à la distance pour un spot) et biais de pente dans la passe d'ombres (`depthBias`, `depthBiasSlopeScale` de l'état de profondeur, `polygonOffset` en WebGL2).

---

## 11. Extensions de l'API abstraite

### 11.1 Textures à usages

Aujourd'hui, `GpuRenderTarget` (`createRenderTarget`) et `GpuTexture` (factory de textures) sont deux notions séparées : une cible de rendu ne peut pas être échantillonnée. Le render graph a besoin de textures qui sont à la fois attachments, échantillonnées, storage ou sources de copie : une seule notion de **texture avec des usages** déclarés à la création, dont `GpuRenderTarget` devient une vue.

### 11.2 Copies et transitions

```ts
interface GpuCommandEncoder {
  beginRenderPass(descriptor: RenderPassDescriptor): GpuRenderPassEncoder;
  beginComputePass(label?: string): GpuComputePassEncoder; // compute graph
  copyBufferToBuffer(…): void;
  copyTextureToTexture(…): void;
  // Explicit backends only; a no-op elsewhere.
  transition(transitions: readonly ResourceTransition[]): void;
  finish(): GpuCommandBuffer;
}

interface ResourceTransition {
  readonly resource: GpuTexture | GpuBuffer;
  readonly from: ResourceUsage; // usages of §6.2
  readonly to: ResourceUsage;
}
```

Les pipelines et passes de calcul sont décrits dans le [compute graph](compute-graph.md#7-extensions-de-lapi-abstraite).

### 11.3 Capacités

| Capacité                                       | WebGPU                     | WebGL2                                        | Vulkan / D3D12 / Metal |
| ---------------------------------------------- | -------------------------- | --------------------------------------------- | ---------------------- |
| `compute`, `storageBuffers`, `storageTextures` | oui                        | non                                           | oui                    |
| `renderableFormats` (dont `rgba16float`)       | oui                        | avec `EXT_color_buffer_float` (très répandue) | oui                    |
| `explicitTransitions`                          | non                        | non                                           | oui                    |
| `bindless`                                     | non (proposition en cours) | non                                           | oui                    |
| `rayQuery`, `rayTracingPipeline`               | non                        | non                                           | selon le matériel      |

---

## 12. Compatibilité avec le ray tracing

| Besoin du ray tracing                               | Réponse du design                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D'autres passes que « un draw par objet »           | Types de passes extensibles (§6.3)                                                                                  |
| Les structures d'accélération comme ressources      | Usages `acceleration-structure-build` / `-read` (§6.2), mêmes règles de dépendances et de transitions               |
| Toute la scène et tous les matériaux à la fois      | Vue de scène en tables (§10.2), capacité `bindless` (§11.3)                                                         |
| La surface sans l'éclairage                         | Cibles de compilation (§8) : `bsdf` en est une de plus                                                              |
| Des shaders de génération, d'impact, de rayon perdu | Le [compute graph](compute-graph.md) avec d'autres sorties (même compilateur, nouvelles entry points)               |
| Le langage                                          | HLSL via DXC sur Vulkan et Direct3D 12 ([§14.1 du material graph](material-graph.md#141-précisions-sur-la-phase-6)) |
| L'hybride (rayons depuis le fragment shader)        | Un nœud `rayQuery` ; la passe déclare la structure en `acceleration-structure-read`                                 |

À **éviter** dans l'implémentation pour ne pas fermer la porte : des passes de rendu qui supposent des bind groups par objet ; un type de ressource limité aux textures et buffers ; une synchronisation implicite dans l'API (les usages doivent être déclarés).

---

## 13. Plan d'implémentation

_RG2 fait._ `RenderGraph` et `RenderGraphRunner` (`engine-core/src/graph`), avec deux ajustements par rapport au §6.4 :

- l'exécution passe par un **`RenderGraphRunner`** de longue durée (`runner.execute(graph, { size })`), qui garde le pool de ressources et le cache de compilation d'une frame à l'autre ; le graphe, lui, est reconstruit à chaque frame ;
- la déclaration d'une passe rend un objet : ses sorties (des handles typés) et sa fonction `execute`. `addRasterPass` rend les sorties, par exemple `opaque.color`.

Une écriture qui efface (`load: 'clear'`) ne dépend pas de la version précédente, qui peut donc être supprimée par le culling ; une passe n'utilise une ressource qu'une fois. L'API abstraite a gagné les usages des textures (une texture peut être un attachment), les copies (`copyBufferToBuffer`, `copyTextureToTexture`) et la méthode optionnelle `transition()` ; les transitions initiales des ressources importées ne sont pas encore émises.

_RG3 fait._ `Renderer.render()` construit à chaque frame un graphe : l'image de la surface importée, une profondeur temporaire, une passe `opaque` (opaques et masqués) et, s'il y a des transparents, une passe `transparent` qui reprend la couleur et teste la profondeur sans l'écrire. `renderer.addScenePasses(graph, options)` ajoute ces passes à un graphe de l'utilisateur et rend la version de la couleur écrite. La suite de rendu passe à l'identique sur Dawn et WebGL2. Mesures (faux backend, sans GPU) : le graphe ajoute environ 15 µs par frame (0,044 → 0,060 ms pour un objet) ; le coût par objet (~20 µs) est inchangé et reste à optimiser ([v2 du material graph](material-graph-v2.md#2-mesures-de-performance)).

_RG4 fait._ La sortie `output.fullscreen` et le builtin `screen-uv` (§9.2) sont dans le compilateur : la descente génère le triangle depuis `vertex-index` et calcule `screen-uv` dans le vertex stage, origine en haut à gauche sur les deux backends ; `screen-uv` hors d'un graphe plein écran est une erreur. `renderer.addFullscreenPass(graph, name, { material, inputs, target, format })` ajoute une passe plein écran : les `inputs` lient des textures du matériau à des versions de ressources du graphe, lues en `sampled` ; la valeur du matériau n'est changée (et son bind group reconstruit) que si la texture du pool change. Les backends déclarent `capabilities.renderableFormats` (`rgba16float` en WebGPU ; en WebGL2 si `EXT_color_buffer_float` est disponible). Avec cette capacité, et sauf `new Renderer(backend, { hdr: false })`, `render()` dessine la scène en couleurs linéaires dans une cible `rgba16float` temporaire (variante des matériaux sans tone mapping ni encodage), puis une passe `tone mapping` construite par le `Renderer` applique l'exposition, l'opérateur et l'encodage de l'option `output` : c'est l'option C. Sans la capacité, le `Renderer` garde l'option B. Toute la suite de rendu passe désormais par le chemin HDR sur Dawn et sur WebGL2 (SwiftShader expose `EXT_color_buffer_float`) ; de nouveaux tests vérifient l'orientation de `screen-uv`, un post-traitement lisant la scène, le mélange exact d'un transparent (blanc à 50 % sur noir : 188 en HDR, 128 avec l'option B) et l'égalité des deux chemins pour chaque opérateur.

Limites : les programmes plein écran gardent les slots `frame` et `object` (indices de groupes fixes ; le `Renderer` fournit les valeurs de la dernière scène et une transformation identité). La création synchrone de leurs pipelines et l'absence de multi-échantillonnage ont été levées avec RG5 (ci-dessous).

_RG5 fait._ Les ombres des lumières directionnelles et des spots, décrites au §10.4 : un atlas rempli par une passe de profondeur, lu par les modèles phong et pbr avec un filtrage PCF. Tests : compilateur (variantes `shadows` et `depthOnly`, 9 comparaisons dans la boucle, programmes unlit inchangés), générateurs (WGSL, GLSL), `Renderer` (tuiles, viewports, objets qui ne projettent pas, matrices et tuiles dans les uniforms) et rendu sur Dawn et WebGL2 (ombre d'une lumière directionnelle et d'un spot comparée au calcul de l'éclairage, absence d'acné sur le sol éclairé, orientation de l'atlas, objet qui ne projette pas). Coût mesuré (faux backend) : 1000 objets statiques passent de 1,8 à 3,1 ms par frame avec une lumière qui projette (chaque objet est dessiné une fois de plus). La démo a une page `/shadows`.

_Finitions du render graph._ En même temps que RG5 :

- **Des uniforms de frame par vue** : chaque `addScenePasses` (par son `name`), chaque tuile d'ombre et chaque passe plein écran a son buffer, écrit à la déclaration. Avant, un buffer unique était réécrit, et deux caméras dans un même graphe voyaient toutes deux la dernière (les écritures de buffer précèdent l'exécution des commandes).
- **Le recouvrement des ressources temporaires** : une ressource revient au pool après sa dernière passe, et une passe suivante de la même frame peut la reprendre si son format, sa taille et ses usages sont les mêmes. Une chaîne de post-traitements n'utilise plus que deux textures. Les listes `acquires` et `releases` par position sont calculées à la compilation.
- **Le multi-échantillonnage** : textures du graphe à `sampleCount`, `pass.resolveColor(target)` qui résout le dernier attachment de couleur dans une texture à la fin de la passe (`resolveTarget` en WebGPU, renderbuffer multi-échantillonné et `blitFramebuffer` en WebGL2). `new Renderer(backend, { samples: 4 })` dessine la scène dans des attachments multi-échantillonnés, résolus dans la cible (HDR ou surface) par la dernière passe de la scène.
- **Le débogage** : `graph.toDot()` décrit le graphe pour Graphviz (passes numérotées dans l'ordre d'exécution, passes supprimées en pointillés, versions des ressources et usages).
- **Les passes** reçoivent la taille des textures (`context.size(handle)`) ; `graph.textureSize(handle)` donne la taille déclarée. Les pipelines plein écran suivent `asyncPipelines`.
- **Mesures** (faux backend, `RenderGraph.bench.ts`) : déclarer et exécuter un graphe (compilation en cache) coûte environ 10 µs pour 3 passes, 28 µs pour 10 et 160 µs pour 50 ; la clé structurelle (une sérialisation du graphe) en est une bonne part, à optimiser si les graphes grossissent.

Restes : ombres des lumières ponctuelles (six faces), cascades pour les grandes scènes (CSM), culling des objets par tuile, transitions initiales des ressources importées.

**Orientation des images en WebGL2.** OpenGL stocke les images rendues de bas en haut. Pour que les images rendues et chargées se lisent de la même façon (ce que demandent les post-traitements), toutes les textures 2d de WebGL2 sont stockées de bas en haut : les chargements sont retournés (`UNPACK_FLIP_Y`), les shaders échantillonnent à `(u, 1 - v)`, et les copies prennent les dernières lignes du stockage. L'API garde la convention de WebGPU (v vers le bas, origine en haut à gauche).

L'étape RG1 (storage buffers et calcul) est décrite dans le [compute graph](compute-graph.md#9-plan-dimplémentation). Les étapes du render graph :

| Étape                                     | Contenu                                                                                                                                                                     | Critère de fin                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **RG2. Cœur du render graph**             | Ressources, versions, usages, culling, ordre, durées de vie, pool, cache, transitions calculées ; passes `raster`, `compute`, `copy` ; textures à usages dans l'API         | Tests du compilateur de graphe sur le faux backend : ordre, culling, réutilisation, transitions |
| **RG3. Renderer sur le render graph**     | Technique forward en passes ; vue de scène (forme par objet) ; profondeur temporaire ; mesures de performance avant et après ([v2 du material graph](material-graph-v2.md)) | Toute la suite de rendu existante passe à l'identique, sur Dawn et WebGL2                       |
| **RG4. HDR et post-traitement**           | `output.fullscreen`, `screen-uv` ; passe de tone mapping ; cible `rgba16float` ; transparents en linéaire ; repli option B                                                  | Tests de rendu du tone mapping et d'un transparent mélangé en linéaire, sur les deux backends   |
| **RG5. Ombres** (facultatif)              | Cible `depth-only` ; shadow maps des lumières directionnelles et spots                                                                                                      | Une ombre comparée à une référence sur les deux backends                                        |
| **RG6. Culling des lumières** (plus tard) | Clustered forward ([évolutions §1](evolutions.md#1-un-très-grand-nombre-de-lumières)), avec les atomiques du compute graph                                                  | Des milliers de lumières à coût par pixel borné                                                 |

---

## 14. Stratégie de test

| Niveau                | Quoi                                                                                                               | Outils                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Compilateur de graphe | Culling, ordre déterministe, versions, lecture avant écriture, durées de vie, union des usages, transitions, cache | Vitest, faux backend           |
| Pool de ressources    | Réutilisation entre frames, redimensionnement, destruction                                                         | Vitest, faux backend           |
| Rendu                 | La suite existante sur le graphe ; tone mapping en passe ; transparents en linéaire ; ombres                       | Dawn et WebGL2, références CPU |
| Performance           | Coût de déclaration et de compilation du graphe par frame                                                          | Vitest `bench`                 |

---

## 15. Risques et décisions

| Sujet          | Risque                                                 | Réponse                                                                                                            |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Coût par frame | Déclaration et clé structurelle à chaque frame         | Cache de compilation ; mesures dès RG3                                                                             |
| WebGL2         | Pas de calcul ni de storage                            | Les passes de calcul n'y sont pas disponibles (décision ci-dessous) ; la technique forward de base n'en dépend pas |
| Formats HDR    | `rgba16float` rendable demande une extension en WebGL2 | Repli sur l'option B                                                                                               |
| Transitions    | Un modèle trop pauvre pour Vulkan et Direct3D 12       | Usages détaillés dès maintenant ; validation au premier backend explicite (phase 6)                                |
| Bindless       | Absent de WebGPU                                       | Vue de scène à deux formes ; tables là où la capacité existe                                                       |

**Décisions (08/10/2026) :**

1. **Le graphe est reconstruit à chaque frame**, avec un cache de compilation (alternative C du §5).
2. **WebGL2 n'a pas de passes de calcul** pour l'instant. Des replis pourront être étudiés plus tard : sur le CPU, ou par rendu dans des textures (voir le [compute graph](compute-graph.md#53-sans-calcul--webgl2)).
3. **Les post-traitements sont des material graphs**, avec la sortie `output.fullscreen` et le builtin `screen-uv` (§9).
4. **RG1 (storage buffers et calcul) d'abord**, puis RG2 et la suite.
