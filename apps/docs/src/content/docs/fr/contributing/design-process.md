---
title: Processus de conception
description: Comment les fonctionnalités sont conçues, décidées et planifiées avant d’être écrites.
sidebar:
  order: 7
---

Toute fonctionnalité importante du moteur commence par un **document de
conception**, dans `design/`, rédigé en français. Le code vient après les
décisions.

## Un document de conception

Les documents suivent le même plan :

1. **Résumé** : ce qui est proposé, en quelques lignes.
2. **Le problème** : ce que fait le moteur aujourd’hui, ce qu’il ne peut
   pas faire, pourquoi c’est important.
3. **Objectif et bénéfice** : ce qu’apporte la fonctionnalité, et à qui.
4. **Coût** : le travail, la complexité ajoutée, ce que cela contraint par
   la suite.
5. **Alternatives** : les autres façons de faire, chacune avec son bénéfice
   et son coût, et pourquoi l’une est choisie.
6. **Conception** : les concepts, l’API, les données, avec des exemples de
   code.
7. **Extensions de l’API abstraite** : ce que les backends doivent fournir.
8. **Plan d’implémentation** : des étapes qui peuvent chacune être testées
   et fusionnées.
9. **Stratégie de test**.
10. **Risques et décisions** : les questions ouvertes, puis les réponses.

Les documents du moteur sont de bons exemples : `material-graph.md`,
`compute-graph.md`, `render-graph.md`, `native-backends.md`.

## De la conception au code

- Les **alternatives sont comparées** avant de choisir, selon leur bénéfice
  et leur coût, et le choix est consigné avec ses raisons.
- La **conception est validée** avant que l’implémentation ne commence ;
  les questions qui la bloquent sont posées, pas devinées.
- L’**implémentation suit le plan**, étape par étape : chaque étape se
  termine avec ses tests qui passent sur tous les backends.
- Une étape qui révèle un problème dans la conception met à jour le
  document : il reste la référence de ce qui a été décidé, et pourquoi.
- Chaque étape terminée est marquée comme faite dans le plan, avec ce
  qu’elle a changé.

## Ce qui n’est pas encore fait

- `design/backlog.md` liste ce qui a été mis de côté, et ce qui est prévu
  ensuite, avec des liens vers les documents qui le détaillent.
- `design/evolutions.md` contient les orientations à plus long terme : un
  très grand nombre de lumières, le ray tracing, le rendu piloté par le GPU
  (GPU-driven rendering), la sortie HDR.

Les améliorations repérées en cours de travail vont là, plutôt que dans la
modification en cours.
