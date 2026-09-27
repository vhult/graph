---
name: release
description: Use when preparing a release from dev to main. Reads the commits dev has that main does not, brings the docs up to date, picks the version, writes the CHANGELOG entry, and proposes the release commit. Does not push, tag or publish.
---

# Release dev to main

This skill helps, it does not automate. It proposes and the user decides. It never runs npm, never pushes and never creates a tag. It gives the commands for those steps.

## 1. Read the commits

- `git log main..dev` with full bodies.
- Skip merge commits and earlier release commits.
- The release is the `@vhult/graph` library only, not the tooling around it. Keep a commit only when it changes the library:
  `git diff-tree --no-commit-id --name-only -r <sha> -- packages/graph/src packages/graph/scripts packages/graph/package.json`
  Skip it when that prints nothing.
- Skip every `docs` commit.
- Every later step uses only the kept commits, including the version bump.

## 2. Bring the docs up to date

The docs site must match the version being released. Apply the `update-docs` skill with `main` as the base: `git diff main...dev -- packages/graph/api/graph.api.md` lists the API changes, and the commits kept in step 1 say why.

The release goes on only when all three pass, from the repo root:

```
node --experimental-strip-types --no-warnings apps/docs/scripts/missing.mjs
npm run typecheck
npm run storybook:build
```

- `missing.mjs` must print `nothing missing`: every export and member has its text.
- `npm run typecheck` also typechecks every example of the docs.
- `npm run storybook:build` fails on a broken link or a name that no longer exists.

If one fails, stop and report it.

The docs changes are their own commit on `dev`, before the release commit:

```
docs: update the docs for v0.2.0
```

Show the diff and the message, then ask `Commit? [Y/n]`. Commit only on `Y`. When the docs are already up to date (all three pass and no API change is left undocumented), say so and make no docs commit. The docs read their version from `packages/graph/package.json`, so the bump in step 6 updates it with nothing to edit.

## 3. Find each author's GitHub login

For each commit, take the first that works:

1. If `gh` is installed: `gh api repos/vhult/graph/commits/<sha> --jq .author.login`
2. When the email is `<id>+<login>@users.noreply.github.com`, take `<login>`.
3. The git author name.

Skip authorship for the maintainer (`hihubble` or `hihubbIe`): their lines get no `@login`.

## 4. Pick the version

Read the current version from `packages/graph/package.json`, then propose a bump:

- `major` if any commit is breaking (`!` or `BREAKING CHANGE:`)
- `minor` if any commit is a `feat`
- `patch` otherwise

State the proposed version and the reason. If the user names another bump, use theirs.

## 5. Write the CHANGELOG entry

`CHANGELOG.md` sits at the repo root. New entries always go at the top, under the `# Changelog` title. Never edit older entries. Create the file if it is missing.

Entry format:

```
## v0.2.0 - 2026-09-23

### Breaking
- api: <what breaks and how to migrate> (abc1234) @login

### Features
- labels: GPU label placement for nodes and edges (5685de4) @login

### Performance
- passes: parallel bucket bases in cull scan_blocks, frame 4.1 -> 3.2 ms, p95 6.0 -> 4.4 ms (3ca17b8) @login

### Fixes
- camera: <summary> (abc1234) @login

### Other
- build: <summary> (abc1234) @login
```

- Sections always come in this order: Breaking, Features, Performance, Fixes, Other. Leave out empty ones.
- `refactor`, `test` and `chore` go in Other.
- One line per commit: `- scope: summary (short sha) @login`. Without a scope, drop the `scope: ` part. Without an author (maintainer), drop the ` @login` part.
- A performance line carries the frame and p95 numbers from the commit's `Perf` block.
- Rewrite a summary only to make it clear. Never change what it says.

## 6. Bump the version

Set the new version in:

- `package.json`
- `packages/graph/package.json`
- `package-lock.json`: the top `version`, `packages[""].version` and `packages["packages/graph"].version`

## 7. Propose the commit

The commit goes on `dev`.

```
chore(release): v0.2.0

<the CHANGELOG entry, without its "## v0.2.0 - date" line>
```

Show the full diff and the message, then ask `Commit? [Y/n]`. Commit only on `Y`. On `n`, change what the user asks and propose again. The commit body is also the description of the dev to main PR.

## 8. Give the commands

After the commit, print these for the user to run. Do not run them.

```
git push origin dev
gh pr create --base main --head dev --title "chore(release): v0.2.0" --body-file <body file>

# after the PR is merged
git checkout main && git pull
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
gh release create v0.2.0 --title "v0.2.0" --notes-file <body file>
npm publish -w @vhult/graph
```
