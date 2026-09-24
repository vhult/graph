---
name: release
description: Use when preparing a release from dev to main. Reads the commits dev has that main does not, picks the version, writes the CHANGELOG entry, and proposes one release commit. Does not push, tag or publish.
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

## 2. Find each author's GitHub login

For each commit, take the first that works:

1. If `gh` is installed: `gh api repos/vhult/graph/commits/<sha> --jq .author.login`
2. When the email is `<id>+<login>@users.noreply.github.com`, take `<login>`.
3. The git author name.

Skip authorship for the maintainer (`hihubble` or `hihubbIe`): their lines get no `@login`.

## 3. Pick the version

Read the current version from `packages/graph/package.json`, then propose a bump:

- `major` if any commit is breaking (`!` or `BREAKING CHANGE:`)
- `minor` if any commit is a `feat`
- `patch` otherwise

State the proposed version and the reason. If the user names another bump, use theirs.

## 4. Write the CHANGELOG entry

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

## 5. Bump the version

Set the new version in:

- `package.json`
- `packages/graph/package.json`
- `package-lock.json`: the top `version`, `packages[""].version` and `packages["packages/graph"].version`

## 6. Propose the commit

The commit goes on `dev`.

```
chore(release): v0.2.0

<the CHANGELOG entry, without its "## v0.2.0 - date" line>
```

Show the full diff and the message, then ask `Commit? [Y/n]`. Commit only on `Y`. On `n`, change what the user asks and propose again. The commit body is also the description of the dev to main PR.

## 7. Give the commands

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
