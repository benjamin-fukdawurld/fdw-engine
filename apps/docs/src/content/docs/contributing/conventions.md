---
title: Conventions
description: Code style, comments, naming, and commits.
sidebar:
  order: 3
---

## Languages

- **Code, comments, READMEs and this documentation**: English.
- **Design documents** (`design/*.md`): French.

## Code

- TypeScript in strict mode (`tsconfig.base.json`): no unused locals,
  no implicit returns, `override` required.
- Formatting by [Prettier](https://prettier.io), with single quotes:
  `npx prettier --write <files>`, or `npx nx format:write`.
- Linting by ESLint with the Nx rules, including the **module boundaries**:
  a project imports another one by its package name (`@fdw/engine-core`),
  never by a relative path, and declares it in its `package.json`.
- Native code: C++20 for the libraries, C for the Node-API bindings; the
  libraries expose a C API in `native/include/fdw/`.

## Writing style

The code reads like prose, and its comments say **why**, not what:

```ts
// Pooled textures are stable: the bind group is rebuilt only when the
// texture changes.
if (material.getValue(input) !== real) {
  material.setValue(input, real);
}
```

- Full words in names: `shadowAtlasSize`, not `shAtlSz`.
- Comments are full sentences, and short. A public API gets a TSDoc comment
  (`/** … */`): the API reference of this site is generated from them.
- Match the surrounding code: its density of comments, its naming, its
  idioms. A change should look as if it had always been there.
- No dead code, no commented-out code.

## Tests

Every change comes with its tests: a unit test next to the code
(`*.spec.ts`), and a test of the rendering suite when it changes what is
drawn. See [Testing](/fdw-engine/contributing/testing/).

## Commits

[Conventional commits](https://www.conventionalcommits.org), with the
package as scope:

```
feat(engine-shader): compute what depends on screen-uv per fragment
fix(vulkan): wait for the readbacks before destroying the buffers
docs(docs): add the compute tutorial
```

`feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`. The message says
what changes for the user of the code.

## Documentation

A change that adds or changes a feature updates:

- the TSDoc comments of its API;
- the `README.md` of its package;
- the pages of this site that describe it: tutorials, guides;
- its design document, if it changes a decision.
