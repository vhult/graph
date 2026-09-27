---
name: update-docs
description: Use when the public docs site (apps/docs) needs to follow a change to the @vhult/graph API, or when adding or editing a docs page or API text. Updates the YAML content, never the React pages.
---

# Update the docs

The docs site is `apps/docs`. It is served at the root of `graph.vhult.com`, with the Storybook under `/storybook/`.

- `apps/docs/content/site.yaml`: header links, GitHub repo and npm package for the widgets, npm badges, landing, docs sidebar, API group order, footer.
- `apps/docs/content/pages/<id>.yaml`: one guide page each.
- `apps/docs/content/api/latest/<group>.yaml`: one API group each, with the text and examples of every export in it.
- `apps/docs/content/api/v<N>/`: the frozen API docs of an older major version, served at `/v<N>/api`. Never edit them. Only the `release` skill creates them.
- The signatures and the short doc comments come from `packages/graph/temp/graph.api.json`, which `npm run build` writes with API Extractor.
- The React code in `apps/docs/src` renders the content. Do not touch it to change content.
- `/llms.txt` and `/llms-full.txt` are the plain Markdown docs for LLMs. `apps/docs/plugins/llms.ts` builds them from the same content and API model, so there is nothing to edit for them.

## 1. Find what changed

The base is `dev` on a feature branch. When the `release` skill runs this skill, the base is `main` and the head is `dev`.

- `git diff <base>...HEAD -- packages/graph/api/graph.api.md` lists the API changes: new, removed and changed exports and members.
- `git log <base>..HEAD` with bodies explains why they changed.

## 2. Refresh the API model

Run `npm run build` at the repo root. It refreshes `temp/graph.api.json`.

## 3. Update the content

- **New export**: add it to the group it belongs to, in `namespace` (the `graph.*` part itself), `types` or `values` (constants and functions). Groups follow `graph.*`: `start`, `nodes`, `edges`, `shared`, `style`, `icons`, `camera`, `input`, `events`, `query`, `canvas`, `debug`. Then write its `docs` entry.
- **New member**: add it under `members` of its export's `docs` entry.
- **Removed export or member**: delete it from its group and its `docs` entry. A name that no longer exists fails the build.
- **Changed behavior**: update the description and the example, and search `apps/docs/content` for the name to fix the guide pages too. Skip the `api/v<N>` folders.
- **New guide page**: add `pages/<id>.yaml` and list `<id>` in a `site.yaml` `docs` section. A page file that is not listed fails the build.

Run `node --experimental-strip-types --no-warnings scripts/missing.mjs [group]` from `apps/docs` to list the exports and members that still have no description. The build also prints the count.

## API text

```yaml
title: Nodes
intro: One or two sentences shown on the API overview.
namespace: GraphNodes
types: [NodeData, NodeUpdate]
values: [NO_INDEX]
docs:
  GraphNodes:
    label: graph.nodes              # optional; graph.* labels are found by themselves
    description: >-
      2 to 4 short sentences.
    example: |
      graph.nodes.clear();
    members:
      set:
        description: >-
          1 to 3 short sentences.
        example: |
          graph.nodes.set({ count: 1 });
```

- Write for someone who does not know the engine yet: what it is for, when to use it, defaults, units (world units, CSS px, ms, radians) and gotchas.
- Short sentences, simple words, no marketing. Write only what the code or its doc comments say: read the source in `packages/graph/src` when a doc comment is not enough.
- Examples go on every function and method, every export, and every setting the user passes in (options, style fields, data channels). Read-only result fields (stats, events payloads, results) get a description only.
- Examples are real TypeScript, 2 to 10 lines, no code comments. Import what they use from `"@vhult/graph"`. The globals `graph`, `canvas`, `simulate(positions)` and `showFallback(message)` exist. Do not use the name `event`.

## Page format

A page is a `title`, an optional `description` and a list of `blocks`. Each block has exactly one of these keys:

```yaml
- heading: Section title          # h2, listed in "On this page"
- subheading: Smaller title       # h3
- text: A paragraph.
- list: [First item, Second item]
- note: Something to keep in mind.
  kind: warning                   # optional, info (default) or warning
- code: |
    graph.camera.fit();
  lang: ts                        # optional: ts (default), tsx, js, sh, text
  title: main.ts                  # optional, shown instead of the language
- table:
    columns: [Name, What]
    rows:
      - ["`pan`", Moves the camera]
- cards:
    - title: Storybook
      text: Every style, live.
      href: /storybook/           # optional
- points:                         # numbered list, used on the landing
    - title: Rendering only
      text: No layout and no simulation.
- api: [Graph, GraphOptions]      # links with the label and summary of each export
```

Text supports `` `code` ``, `**bold**` and `[label](href)`. Code that starts with an exported name links to its API page by itself: `` `Graph` `` links to `/api/Graph` and `` `Graph.create` `` to `/api/Graph#create`.

Internal links are checked at build: `/`, `/api`, `/api/<Export>`, `/docs/<page id>` and `/storybook/`, each with an optional `#anchor`. A broken link fails the build. Always write `/api/...`, never `/v<N>/api/...`: a frozen version rewrites its own links.

Quote a YAML string that holds `: ` or starts with a backtick, `[` or `{`.

## 4. Verify

From the repo root:

```
npm run typecheck
npm run storybook:build
```

- For a release, `node --experimental-strip-types --no-warnings apps/docs/scripts/missing.mjs` must print `nothing missing`. On a feature branch, missing text is a warning.
- `npm run typecheck` also writes every TypeScript example of the content to `apps/docs/examples.gen` and typechecks it against the library. The file name tells where an error comes from, for example `api-nodes-GraphNodes-set.ts` or `page-camera-2.ts`.
- `storybook:build` builds the library, the Storybook and the docs, like the deploy does. The docs build fails on any content error and names the file and the block.

Then run `npm run dev` and open http://localhost:5173 to check the pages you changed.

## 5. Report

List the groups and pages you changed, and any behavior you could not confirm from the source.

## Adding a block type

Only when no existing block fits. Change all four together:

1. `apps/docs/src/content/types.ts`: add it to `Block`.
2. `apps/docs/plugins/content.ts`: add its check to `BLOCKS`.
3. `apps/docs/src/render/Blocks.tsx`: render it in `BlockView`.
4. `apps/docs/src/styles.css`: style it.

Then add it to the format above.
