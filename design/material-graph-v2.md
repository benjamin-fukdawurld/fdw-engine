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

**Mesures de référence** (08/10/2026, Node 24, machine de développement ; `npx vitest bench --run` dans `engine-shader` et `engine-core`). Le `Renderer` est mesuré sur un faux backend, sans GPU : seul le coût du moteur compte.

| Mesure                                             | Temps moyen |
| -------------------------------------------------- | ----------- |
| Compilation d'un graphe unlit texturé              | 0,9 ms      |
| Compilation d'un graphe Phong                      | 3,7 ms      |
| Compilation d'un graphe PBR                        | 6,7 ms      |
| Compilation d'un graphe avec 16 fonctions inlinées | 2,6 ms      |
| `Renderer.render()`, 1 objet                       | 0,04 ms     |
| `Renderer.render()`, 100 objets immobiles          | 2,1 ms      |
| `Renderer.render()`, 1 000 objets immobiles        | 20,5 ms     |
| `Renderer.render()`, 1 000 objets en mouvement     | 31,9 ms     |
| `Renderer.render()`, 100 objets, 100 matériaux     | 2,3 ms      |

Après RG3 (le `Renderer` sur le render graph) : 0,060 ms pour un objet, 20,5 ms pour 1 000 objets immobiles ; le graphe ajoute environ 15 µs par frame, le coût par objet ne change pas.

**Constat** : environ **20 µs de CPU par objet et par frame**, même immobile ; 1 000 objets dépassent le budget d'une frame à 60 Hz (16,7 ms). Suspects : les clés recalculées pour chaque objet à chaque frame (`JSON.stringify` de l'état de rendu et du layout de vertex, clé de programme), le tri par comparaison de chaînes. La compilation, elle, n'a lieu qu'une fois par programme : quelques millisecondes, acceptables.

**Pistes.**

- Benchmarks reproductibles : faits (`compile.bench.ts`, `Renderer.bench.ts`).
- Mettre en cache, par objet, les clés de pipeline et de programme, et trier sur des entiers : **fait** (09/10/2026), voir ci-dessous.
- Mesures dans les tests de rendu (Dawn et WebGL2) : création des pipelines, temps de `render()`.
- Compteurs exposés par le `Renderer` (programmes compilés, pipelines créés, uniforms réécrits par frame) pour la démo et le diagnostic.

**Optimisation du `Renderer` (09/10/2026).** Le profil de 200 frames de 1 000 objets immobiles donnait : ~50 % du temps dans `createBindGroupLayout`, appelé à chaque draw pour chaque groupe (les backends construisent une clé en `JSON.stringify` à chaque appel) ; ~25 % dans la préparation des objets (clés de programme et de pipeline recalculées par `JSON.stringify`) ; le tri par comparaison de chaînes. Corrections : layouts de bind group en cache par groupe physique ; programme, layout et clé de pipeline en cache par matériau, mesh et passe (invalidés quand les features du matériau changent) ; un identifiant numérique par pipeline pour le tri.

| Mesure                    | Avant    | Après    |
| ------------------------- | -------- | -------- |
| 1 objet                   | 0,060 ms | 0,029 ms |
| 100 objets immobiles      | 2,5 ms   | 0,25 ms  |
| 1 000 objets immobiles    | 20,5 ms  | 2,7 ms   |
| 1 000 objets en mouvement | 35,8 ms  | 12,8 ms  |
| 100 objets, 100 matériaux | 2,2 ms   | 0,26 ms  |

**Pistes restantes** pour les objets en mouvement (~12 µs par objet, dont une part due au faux backend) : réutiliser le buffer CPU des uniforms de chaque objet au lieu d'en allouer un par mise à jour ; alléger la vérification de version des `CachedValue` des transformations.
