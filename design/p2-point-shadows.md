# Les ombres des lumières ponctuelles

Le reste de la phase P2 ([p2-lights §9](p2-lights.md#9-reportés)), troisième chantier de la [roadmap revue le 30 octobre 2026](roadmap.md#2-vue-densemble) : les lumières ponctuelles projettent des ombres, en rastérisation, sur les quatre backends.

Contraintes : les mêmes graphs et le même compilateur sur WebGPU, WebGL2, Vulkan et Direct3D 12 ; WebGL2 n'a ni tableau de cubemaps ni rendu en calcul ; `light.shadow` garde sa signature : les shading models de l'application ne changent pas ; le pool de lumières garde son enregistrement ([p2-lights §3](p2-lights.md)).

## 1. Aujourd'hui

| Ce qui existe                                                                                                                                                              | Ce qui manque                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Un **atlas d'ombres** carré (`shadowAtlasSize`, 2048 par défaut), une grille de tuiles égales : une par lumière, une par cascade (`ShadowCameras.tiles`, `render/shadows.ts`) | Les `PointLight` n'ont ni `castShadow` ni `shadow` (`castsShadow` ne retient que les directionnelles et les spots) |
| Une passe d'ombres, une vue par tuile : les projeteurs culés par le frustum de la tuile, instanciés comme dans la scène (`Renderer.addShadowPass`)                         | Une projection qui couvre toutes les directions                   |
| `light.shadowMap` : une matrice par lumière (`shadowMatrix`), quatre pour les cascades, un PCF 3 × 3 par `textureSampleCompare`, l'uv gardé dans la tuile                    |                                                                   |
| Les ombres par rayons (`light.shadowRay`) gèrent déjà les lumières ponctuelles (`position.w`)                                                                              | Seul `castsShadow` les en écarte                                  |

## 2. Les options

| Option                                                                                                               | Pour                                                                                                                                                         | Contre                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Six faces dans l'atlas** : six tuiles à 90°, la face choisie dans le shader par l'axe dominant                  | Rien de nouveau dans les backends : le même atlas, la même passe, le même sampler de comparaison ; WebGL2 compris ; le culling par face existe déjà (une vue par tuile) | Six tuiles par lumière : l'atlas se partage vite ; le PCF bave au bord des faces (§3.3)                                                                         |
| B. Une cubemap de profondeur par lumière (ou un tableau de cubemaps)                                                 | Le filtrage à travers les arêtes du cube, fait par le matériel                                                                                                | Le rendu dans les faces d'un cube et `textureSampleCompare` sur un cube dans les quatre backends et le compilateur ; un binding par lumière, ou un tableau de cubes, que WebGL2 n'a pas : incompatible avec le pool sans limite |
| C. Double paraboloïde : deux tuiles                                                                                  | Trois fois moins de place dans l'atlas                                                                                                                        | La projection n'est pas linéaire : les grands triangles se déforment, il faut des meshes fins ; une passe d'ombres à part (le sommet projeté dans le shader)  |
| D. Seulement les rayons (`rays`)                                                                                     | Déjà là                                                                                                                                                      | Pas sur WebGL2, ni sans ray tracing matériel ou logiciel ; trop cher pour l'éditeur                                                                             |

**Recommandé : A.** C'est le prolongement direct de l'atlas, sans toucher aux backends ; B ne vaudrait que pour un grand nombre de lumières à ombres, et ce cas appartient aux rayons (D, qui marchera en plus, pour rien).

## 3. Le mécanisme

### 3.1 Les faces

Une lumière ponctuelle à ombres prend **six emplacements consécutifs** de la grille de l'atlas, dans l'ordre +X, −X, +Y, −Y, +Z, −Z. Chaque face a sa caméra en perspective (carrée, à la position de la lumière), son frustum, ses projeteurs : `ShadowCameras.tiles` en rend six `ShadowTile`, que `addShadowPass` dessine sans changement.

- **Le plan lointain** : la portée de la lumière (`lightRange`), bornée par la distance aux récepteurs, comme pour un spot ; sans portée (pas d'atténuation), la distance aux récepteurs. Le plan proche : `far × 0,002`, comme pour un spot.
- **Les faces inutiles ne sont pas dessinées** : une face dont le frustum ne touche pas les récepteurs (ce que la caméra voit) garde son emplacement, pour l'adressage, mais n'a pas de draw. Une lampe au plafond hors champ ne coûte alors que ses faces visibles.

### 3.2 Dans le shader

`shadow.x = 3` envoie `light.shadowMap` aux faces (1 : une tuile, 2 : les cascades). L'enregistrement du pool ne change pas de taille : la matrice d'ombre, inutile ici, porte ce qu'il faut :

| Colonne de `shadowMatrix` | Valeur                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0                         | l'emplacement de la face +X dans la grille, le nombre de colonnes, la taille d'une tuile en uv, l'échelle de la face (§3.3) |
| 1                         | les deux termes de la profondeur projetée, `ndc.z = a + b / m` (lus dans la matrice de projection de la face sur le CPU : la convention de profondeur de chaque backend est respectée sans la connaître) |

Pour un point `p` : `d = p − position` (après le décalage le long de la normale), l'axe dominant donne la face `f` et `m = |d|` sur cet axe ; l'uv de la face vient des deux autres composantes divisées par `m`, dans les axes de la caméra de la face (une même table, en TypeScript, sert au CPU et au graphe : un test les compare) ; la tuile est l'emplacement `premier + f`, sa position `(i mod colonnes, ⌊i / colonnes⌋) × taille`. Le reste (le PCF, la garde dans la tuile, le biais) est celui d'aujourd'hui. Pas de branche : des `select`, comme pour les cascades.

Le décalage le long de la normale (`normalBias`) suit la taille d'un texel à la distance du point, comme pour un spot.

### 3.3 Les arêtes du cube

Le PCF 3 × 3 lit un texel de chaque côté ; la garde dans la tuile le coupe au bord de la face, d'où une ligne visible sur les arêtes du cube. Chaque face est rendue **un peu plus large que 90°** : une marge de deux texels (`tan(fov / 2) = 1 + 4 / taille`), et l'uv multiplié par l'échelle inverse. Le filtrage reste alors dans la tuile sans toucher l'arête. C'est la solution de la plupart des moteurs sans cubemap (ce que fait déjà le spot : `outerCutoff + 4°`).

### 3.4 La place dans l'atlas

Avec la grille actuelle, un soleil à quatre cascades et deux lampes à ombres font 4 + 12 = 16 emplacements : 4 colonnes, des tuiles de 512 pixels dans un atlas de 2048. Ce qu'on documente : `shadowAtlasSize`, et peu de lampes à ombres (les autres sans). **Reporté** : un atlas à tuiles de tailles différentes (la taille selon la distance à la caméra), et le cache des ombres des lumières et des projeteurs immobiles ; tous deux valent aussi pour les spots.

## 4. L'API

```ts
const lamp = new PointLight({
  position: { x: 0, y: 3, z: 0 },
  quadraticAttenuation: 0.1,
  castShadow: true,
  shadow: { normalBias: 1.5 },
});
```

`PointLight` implémente `ShadowCaster` comme `SpotLight`. `ShadowOptions` : `bias`, `normalBias` et `softness` valent pour elle ; `bounds` et `cascades` restent propres aux directionnelles (déjà documenté). `castsShadow` les accepte : les ombres par rayons marchent du même coup. `engine-scene-io` et `engine-gltf` (l'extension `KHR_lights_punctual` n'a pas d'ombres : rien côté glTF) enregistrent `castShadow` et `shadow` des lumières ponctuelles comme ceux des spots.

## 5. Tests

- **CPU** : six tuiles par lumière, consécutives ; une face hors des récepteurs sans draw ; les points de chaque face projetés par la matrice de la face et par le calcul du graphe (la même table) tombent au même uv et à la même profondeur.
- **Rendu, sur les quatre backends** : une lampe au centre d'une boîte, un cube occultant sur chacun des six axes ; l'ombre de chaque cube au pixel attendu ; un point sur l'arête de deux faces sans ligne (§3.3). La même image en rastérisation et par rayons (WebGPU logiciel, Vulkan, Direct3D 12), à la tolérance près ; en forward et en différé.
- **Mesure** : la scène `deferred` avec deux lampes à ombres, le temps de la passe d'ombres avant et après le saut des faces inutiles.

## 6. Les étapes

| Étape                    | Contenu                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **1. Le CPU**            | `PointLight` et `ShadowCaster`, les six faces dans `ShadowCameras`, le pool (`shadow.x = 3`), le saut des faces inutiles ; scene-io |
| **2. Le shader**         | La branche des faces dans `light.shadowMap`, la marge des arêtes ; tests de rendu sur les quatre backends     |
| **3. La doc et la démo** | Le guide « Lights and shadows » et le tutoriel « Lumières et ombres » (EN, FR) avec une lampe à ombres, ses captures ; dans la scène `deferred`, deux des lampes projettent leurs ombres (touche S) |

## 7. Décisions à valider

1. **Six faces dans l'atlas** (option A) plutôt qu'une cubemap.
2. **La matrice d'ombre réutilisée** pour les paramètres des faces, sans agrandir l'enregistrement du pool.
3. **Des faces élargies** contre la ligne des arêtes, plutôt qu'un filtrage d'une face à l'autre.
4. **Reportés** : l'atlas à tailles variables, le cache des ombres immobiles.

## 8. État

- **Étape 1 faite** (4 novembre 2026) : `PointLight` implémente `ShadowCaster` ; `CubeShadowFaces` (`engine-shader`, la table des axes partagée avec les shaders) ; six tuiles consécutives dans `ShadowCameras.tiles` (`face`, et `faces` sur la première : ce que le pool range à la place de la matrice) ; `cubeFaceTangent` ; `shadow.x = 3` dans le pool ; une face qui ne voit pas les récepteurs ne dessine rien ; les ombres par rayons des lumières ponctuelles ; `engine-scene-io`. Tests : la projection par la matrice de chaque face et par le calcul des shaders tombent au même uv et à la même profondeur, à l'intérieur de la tuile, y compris près d'une arête. **Tant que l'étape 2 manque, `light.shadowMap` lit les faces comme des cascades : ne pas activer `castShadow` sur une lumière ponctuelle en rastérisation.**
