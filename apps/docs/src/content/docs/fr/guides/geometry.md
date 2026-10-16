---
title: Géométrie
description: Volumes, intersections, rayons et index spatiaux, pour le culling, le picking et la physique.
sidebar:
  order: 8
---

`@fdw/engine-geometry` est du TypeScript pur, sans dépendance : le renderer
s'en sert pour le culling, la scène pour indexer ses nœuds, et une
application, un moteur physique ou un outil peuvent l'utiliser seuls.

## Volumes

Chaque volume implémente `Volume` :

| Membre                 | Rôle                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `kind`                 | Son type (`'aabb'`, `'sphere'`…), pour les tests d'intersection rapides            |
| `bounds(out?)`         | Une boîte qui le contient : ce que stockent les index spatiaux                     |
| `transform(matrix)`    | Le plus petit volume du même type qui le contient, transformé                      |
| `containsPoint(point)` | Si un point est à l'intérieur                                                      |
| `raycast(ray)`         | La distance le long d'un rayon jusqu'au volume, 0 depuis l'intérieur, ou undefined |

Le moteur fournit ces volumes :

| Volume    | Usage                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `Aabb`    | Une boîte alignée sur les axes : les index, le culling                                               |
| `Sphere`  | Centre et rayon                                                                                      |
| `Obb`     | Une boîte orientée selon trois axes : l'englobant serré d'un objet tourné                            |
| `Capsule` | Les points situés à moins d'un rayon d'un segment : les personnages                                  |
| `Frustum` | Six plans issus d'une matrice vue-projection (`Frustum.fromMatrix()`), le volume que voit une caméra |

Un `Ray` (une origine, une direction unitaire) n'est pas un volume, mais
chaque requête en accepte un. Les vecteurs sont des tableaux `[x, y, z]` ;
les matrices sont en 4 × 4, en column-major. Les fonctions appelées par
objet et par frame écrivent dans un argument `out` : rien n'est alloué dans
les boucles critiques.

## Vos propres volumes

Un volume **convexe** ajoute une fonction de support : le point du volume le
plus éloigné dans une direction.

```ts
class Cylinder implements ConvexVolume {
  readonly kind = 'cylinder';
  constructor(
    readonly center: Vec3,
    readonly radius: number,
    readonly halfHeight: number,
  ) {}

  support([dx, dy, dz]: ReadonlyVec3, out: Vec3): Vec3 {
    const horizontal = Math.hypot(dx, dz) || 1;
    return set(
      out,
      this.center[0] + (dx / horizontal) * this.radius,
      this.center[1] + (dy >= 0 ? this.halfHeight : -this.halfHeight),
      this.center[2] + (dz / horizontal) * this.radius,
    );
  }
  // bounds(), transform(), containsPoint(), raycast()…
}
```

Cela suffit pour que `intersects()` le teste contre n'importe quel autre
volume convexe : il utilise **GJK**, qui n'a besoin que des fonctions de
support des deux volumes. Un moteur physique s'appuierait sur la même
fonction (EPA, l'étape suivant GJK, donne la pénétration et la normale de
contact).

## Intersections

```ts
intersects(
  new Capsule([0, 0, 0], [0, 2, 0], 0.5),
  new Obb([1, 1, 0], [0.6, 0.6, 0.6]),
);
```

`intersects(a, b)` utilise le test enregistré pour les types des deux
volumes — boîte–boîte, sphère–sphère, sphère–boîte, capsule–capsule,
capsule–sphère — et GJK sinon. Un test exact plus rapide pour une paire de
vos propres types :

```ts
registerIntersection<Cylinder, Sphere>('cylinder', 'sphere', (cylinder, sphere) => …);
```

Un volume sans fonction de support et sans test enregistré lève une erreur
explicite.

Le culling utilise des tests plus rapides et conservateurs :
`frustum.classifyAabb(box)` répond `outside`, `intersects` ou `inside` (un
index spatial accepte alors une cellule entière sans tester ses éléments),
`frustum.intersectsSphere()`. Une boîte proche d'un bord du frustum, mais à
l'extérieur, peut être signalée comme en intersection : elle est dessinée
pour rien, jamais oubliée.

## Index spatiaux

Un `SpatialIndex` stocke des éléments selon leur englobant, et répond aux
requêtes :

```ts
const index = new Octree<Enemy>();
index.insert(enemy, enemy.bounds);
index.update(enemy, enemy.bounds); // it moved
index.queryFrustum(frustum, (enemy, inside) => …);
index.queryVolume(new Sphere(position, 10), (enemy) => …);
index.raycast(ray, (enemy, distance) => { … return false; }); // nearest first
```

Il ne sait rien des éléments : nœuds, identifiants d'entités, objets de
l'application. Deux implémentations :

- `LinearIndex` : teste chaque élément. La référence, et le bon choix en
  dessous de quelques centaines d'éléments.
- `Octree` : un octree **lâche** (loose). Chaque cellule accepte les
  éléments qui tiennent dans son englobant agrandi d'un facteur 2 : un
  élément est stocké dans une seule cellule, aussi profonde que sa taille le
  permet, et un élément qui bouge un peu reste dans sa cellule. Sa racine
  s'agrandit lorsqu'un élément en sort. `insertAll()` le construit de haut
  en bas pour de nombreux éléments à la fois.

Sur 10 000 éléments, une requête de frustum prend environ 0,06 ms, le
premier impact d'un rayon 7 µs, et le déplacement de 1000 éléments 0,09 ms.
