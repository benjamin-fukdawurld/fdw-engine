# Material graph : améliorations pour la v2

Améliorations relevées par le [bilan du material graph](material-graph.md#18-bilan-du-material-graph), qui ne bloquent pas les étapes suivantes. Les écarts au design sont listés à part, dans [material-graph-gaps.md](material-graph-gaps.md).

## 1. Constantes répétées dans le code généré

**Constat.** Une constante est émise à chaque utilisation, y compris dans les corps de boucle. Dans le fragment shader Phong, par exemple, `vec3(0.5, 0.25, 1.0)` (la couleur de base) apparaît deux fois dans la boucle sur les lumières, et chaque `0.0` des `max(x, 0.0)` a sa propre variable :

```glsl
for (uint v10 = 0u; v10 < v9; v10++) {
  vec3 v34 = vec3(0.5, 0.25, 1.0);
  vec3 v35 = v15 * v34;
  vec3 v36 = vec3(0.5, 0.25, 1.0);
  vec3 v37 = v18 * v36;
  float v55 = 0.0;
  float v56 = max(v49, v55);
  …
```

**Cause.** Les entrées non connectées d'un nœud (valeurs par défaut, littéraux) sont traduites en une instruction `constant` à chaque lecture (`StageBuilder.input`), sans cache. La CSE travaille sur le graphe, où ces littéraux ne sont pas des nœuds.

**Impact.** Probablement nul sur les performances : les compilateurs des pilotes dédupliquent les constantes. Le code généré est en revanche plus long et moins lisible, ce qui gêne le débogage.

**Pistes.**

- Mettre les constantes en cache par type et valeur dans `StageBuilder`, au niveau de la portée la plus externe (avant les boucles) : une seule instruction par constante et par stage.
- Ou émettre les constantes en ligne dans les générateurs (`max(v49, 0.0)`), sans variable : plus lisible, et sans changement de l'IR.

## 2. Mesures de performance

**Constat.** Aucune mesure n'existe. On ne sait pas :

- combien de temps prend la compilation d'un matériau (validation, expansion des macros et inlining, optimisations, génération de l'IR), ni la génération du code et la création du pipeline par backend ;
- quel est le coût CPU du `Renderer` par objet et par frame (préparation, tri, mises à jour des uniforms, bind groups, enregistrement des commandes) ;
- comment ces coûts évoluent avec la taille des graphes (nombre de nœuds, fonctions inlinées) et le nombre d'objets.

**Pourquoi c'est important.** Le compilateur revalide le graphe complet à chaque passe d'expansion, et le `Renderer` recalcule des clés en chaînes JSON à chaque frame (`pipelineKey`, clés de variantes) : ce sont des candidats naturels à l'optimisation, mais sans mesure on ne sait pas lesquels comptent. Le render graph va réorganiser la boucle de rendu : il faut une référence avant.

**Pistes.**

- Benchmarks reproductibles (Vitest `bench`) : compilation d'un graphe unlit, Phong, PBR, d'un graphe avec fonctions imbriquées ; un `Renderer` sur le faux backend avec 1, 100 et 10 000 objets.
- Mesures dans les tests de rendu (Dawn et WebGL2) : création des pipelines, temps de `render()`.
- Compteurs exposés par le `Renderer` (programmes compilés, pipelines créés, uniforms réécrits par frame) pour la démo et le diagnostic.
