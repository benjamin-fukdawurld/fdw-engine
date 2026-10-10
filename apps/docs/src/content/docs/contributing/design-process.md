---
title: Design process
description: How features are designed, decided and planned before they are written.
sidebar:
  order: 7
---

Every significant feature of the engine starts with a **design document**,
in `design/`, written in French. The code comes after the decisions.

## A design document

The documents follow the same outline:

1. **Summary**: what is proposed, in a few lines.
2. **The problem**: what the engine does today, what it cannot do, why it
   matters.
3. **Goal and benefit**: what the feature brings, to whom.
4. **Cost**: the work, the complexity added, what it constrains later.
5. **Alternatives**: the other ways to do it, each with its benefit and its
   cost, and why one is chosen.
6. **Design**: the concepts, the API, the data, with examples of code.
7. **Extensions of the abstract API**: what the backends must provide.
8. **Implementation plan**: steps that can each be tested and merged.
9. **Test strategy**.
10. **Risks and decisions**: the open questions, then the answers.

The documents of the engine are good examples: `material-graph.md`,
`compute-graph.md`, `render-graph.md`, `native-backends.md`.

## From design to code

- The **alternatives are compared** before choosing, by their benefit and
  their cost, and the choice is written down with its reasons.
- The **design is validated** before the implementation starts; questions
  that block it are asked, not guessed.
- The **implementation follows the plan**, step by step: each step ends with
  its tests passing on every backend.
- A step that reveals a problem in the design updates the document: it
  stays the reference of what was decided and why.
- Each finished step is marked as done in the plan, with what it changed.

## What is not done yet

- `design/backlog.md` lists what was set aside, and what is planned next,
  with links to the documents that detail it.
- `design/evolutions.md` holds the longer-term directions: a very large
  number of lights, ray tracing, GPU-driven rendering, HDR output.

Improvements found while working go there, rather than into the current
change.
