---
title: Conventions
description: Style du code, commentaires, nommage et commits.
sidebar:
  order: 3
---

## Langues

- **Code, commentaires, README et cette documentation** : anglais.
- **Documents de conception** (`design/*.md`) : français.

## Code

- TypeScript en mode strict (`tsconfig.base.json`) : pas de variables
  locales inutilisées, pas de retours implicites, `override` obligatoire.
- Formatage par [Prettier](https://prettier.io), avec des guillemets
  simples : `npx prettier --write <files>`, ou `npx nx format:write`.
- Lint par ESLint avec les règles Nx, dont les **frontières de modules** :
  un projet en importe un autre par son nom de paquet (`@fdw/engine-core`),
  jamais par un chemin relatif, et le déclare dans son `package.json`.
- Code natif : C++20 pour les bibliothèques, C pour les bindings Node-API ;
  les bibliothèques exposent une API C dans `native/include/fdw/`.

## Style d’écriture

Le code se lit comme de la prose, et ses commentaires disent **pourquoi**,
pas quoi :

```ts
// Pooled textures are stable: the bind group is rebuilt only when the
// texture changes.
if (material.getValue(input) !== real) {
  material.setValue(input, real);
}
```

- Des mots complets dans les noms : `shadowAtlasSize`, pas `shAtlSz`.
- Les commentaires sont des phrases complètes, et courtes. Une API publique
  reçoit un commentaire TSDoc (`/** … */`) : la référence de l’API de ce
  site est générée à partir d’eux.
- Alignez-vous sur le code environnant : sa densité de commentaires, son
  nommage, ses idiomes. Une modification doit donner l’impression d’avoir
  toujours été là.
- Pas de code mort, pas de code commenté.

## Tests

Chaque modification s’accompagne de ses tests : un test unitaire à côté du
code (`*.spec.ts`), et un test de la suite de rendu lorsqu’elle change ce
qui est dessiné. Voir [Tests](/fdw-engine/fr/contributing/testing/).

## Commits

[Conventional commits](https://www.conventionalcommits.org), avec le paquet
comme scope :

```
feat(engine-shader): compute what depends on screen-uv per fragment
fix(vulkan): wait for the readbacks before destroying the buffers
docs(docs): add the compute tutorial
```

`feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`. Le message dit
ce qui change pour l’utilisateur du code.

## Documentation

Une modification qui ajoute ou modifie une fonctionnalité met à jour :

- les commentaires TSDoc de son API ;
- le `README.md` de son paquet ;
- les pages de ce site qui la décrivent : tutoriels, guides ;
- son document de conception, si elle change une décision.
