---
title: La navigation
description: Les maillages de navigation construits à partir des volumes d'une scène ou de triangles, les chemins qu'on y trouve (A* et l'entonnoir), et les agents qui les suivent.
sidebar:
  order: 21
---

`@fdw/engine-navigation` trouve où des agents peuvent marcher, et les
chemins entre deux points. Du TypeScript pur, sur les volumes de
`@fdw/engine-geometry` et les requêtes de `@fdw/engine-scene` ; il ne
déplace rien lui-même : un [contrôleur de personnage](/fdw-engine/fr/guides/physics/#un-personnage-sans-moteur)
s'en charge. Le tutoriel [La navigation](/fdw-engine/fr/tutorials/navigation/)
réunit le tout.

| Export         | Quoi                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `NavMesh`      | Des polygones convexes reliés par des portails : `findPath`, `closestPoint`, `toData` |
| `buildNavMesh` | Un maillage de navigation des volumes d'une région (et d'une fonction du sol)         |
| `sceneVolumes` | Les volumes des renderers d'une scène, dans le monde                                  |
| `NavAgent`     | Suit les chemins : le déplacement de chaque pas vers le prochain coin                 |

## Construire à partir de volumes

```ts
const navMesh = buildNavMesh({
  bounds: new Aabb([-50, -5, -50], [50, 20, 50]),
  volumes: sceneVolumes(scene, { filter: (node) => node.static }),
  ground: (x, z) => terrain.height(x, z), // facultatif
  cellSize: 0.25,
  agentRadius: 0.4,
  agentHeight: 1.8,
  maxClimb: 0.4,
  maxSlope: Math.PI / 4,
});
```

Les étapes, toutes sur le CPU :

1. **Les colonnes.** La région est découpée en colonnes de `cellSize`.
   Chaque volume donne l'intervalle vertical qu'il remplit dans les
   colonnes qu'il couvre : sa boîte pour un `Aabb`, deux rayons (vers le bas
   et vers le haut) au centre de la colonne pour les autres — une boîte
   orientée fait une rampe, une sphère un dôme. La fonction du sol remplit
   tout ce qui est sous elle.
2. **Les sols.** Les intervalles d'une colonne sont fusionnés ; le dessus
   de chacun est un **sol** quand le suivant commence au moins
   `agentHeight` plus haut. Une colonne a plusieurs sols sous un pont ou un
   étage.
3. **Les liens.** Un sol est relié au sol de chacune de ses 4 colonnes
   voisines dont la hauteur diffère de `maxClimb` au plus (ou de
   `cellSize × tan(maxSlope)`, pour une pente), avec de la place pour
   l'agent sur les deux. Un sol plus raide que `maxSlope` entre ses voisins
   est écarté.
4. **L'érosion.** La distance de chaque sol au bord le plus proche (un sol
   à qui manque un lien) se propage par les liens, droits et diagonaux ;
   les sols plus proches que `agentRadius` sont écartés. Les agents restent
   ainsi loin des murs et des vides quel que soit leur chemin, et les
   chemins n'ont besoin d'aucun décalage.
5. **Les polygones.** Les sols plats sont rassemblés en rectangles, selon x
   puis z ; chaque rectangle est un polygone, relié à ses voisins par un
   **portail** : la partie de leur bord commun où leurs sols sont reliés.

Le coût croît avec le nombre de colonnes : des cellules de 0,25 m sur
100 × 100 m font 160 000 colonnes. À construire une fois, au chargement du
niveau, ou hors ligne (`toData()`) ; un niveau qui change se reconstruit.

Le dessus des murs est aussi un sol quand un agent y tient : des îles,
reliées à rien. `findPath` ne les atteint pas.

## D'autres sources

```ts
// Les triangles praticables d'un mesh : pas plus raides que maxSlope.
const fromMesh = NavMesh.fromTriangles(positions, indices, { maxSlope });
// Enregistré, puis rechargé.
const data = navMesh.toData(); // du JSON simple
const again = new NavMesh(data);
```

`fromTriangles` soude les sommets et relie les triangles par leurs arêtes
communes. Les triangles sont parcourus tels quels : ils doivent rester loin
des murs du rayon des agents. `NavMeshData` prend des polygones convexes
d'autant de sommets qu'on veut, et des `links` (portails) quand les
polygones ne partagent pas leurs arêtes.

## Les chemins

```ts
const corners = navMesh.findPath(start, end, { partial: true, maxDistance: 2 });
const nearest = navMesh.closestPoint(point); // { polygon, point }
```

- **La localisation.** Les polygones sont rangés dans des cases en x et z ;
  `closestPoint` cherche par anneaux de cases autour du point, le point le
  plus proche d'un polygone (en trois dimensions : sous un pont, le sol le
  plus proche en hauteur).
- **A\*** sur les polygones : le chemin entre dans chaque polygone en un
  point de son portail, celui du plus court trajet du point d'entrée du
  polygone précédent jusqu'à l'arrivée (une recherche par la section dorée
  le long du portail : les grands polygones ne le trompent pas comme leurs
  milieux le feraient) ; le coût est la longueur de ces segments,
  l'heuristique la distance à vol d'oiseau jusqu'à l'arrivée.
- **L'entonnoir** (le « simple stupid funnel algorithm » de Mikko
  Mononen) : le couloir de polygones comme une suite de portails, le chemin
  tendu à travers eux ; ses coins sont des bouts de portails : les coins de
  la zone praticable, à `agentRadius` des murs.

## Les agents

```ts
const agent = new NavAgent(navMesh, {
  speed: 3,
  tolerance: 0.1, // un coin à moins de cela est atteint
  maxDeviation: 1, // un nouveau chemin au-delà
});
agent.setDestination(position, target); // false : pas de chemin
const step = agent.update(position, dt); // déplacement horizontal de ce pas
agent.idle; // arrivé, arrêté, ou sans chemin
agent.remaining(position); // les mètres le long du chemin
```

`update` dépense `speed × dt` le long des coins, passe ceux qu'il atteint,
et ne va jamais au-delà du dernier. Le y du déplacement vaut 0 : la gravité
est l'affaire du contrôleur.

## Limites

- Le maillage de navigation est statique : pas d'obstacles découpés en
  cours de jeu, pas de tuiles reconstruites seules.
- Pas d'évitement entre agents : ils se traversent (un contrôleur de la
  physique les écarte).
- Pas encore de liens hors du maillage (un saut, une échelle).
