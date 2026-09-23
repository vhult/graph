---
name: open-pr
description: Use when opening a pull request for changes on a feature branch. Verifies the branch, writes the PR in the repo format, and targets dev.
---

# Open a PR

The base branch is always `dev`.

## 1. Read the changes

- `git log dev..HEAD` with bodies, and `git diff dev...HEAD`.
- Understand the root cause (for a fix) or the need (for a feature) before writing anything.

## 2. Verify

Run all three from the repo root and read the full output:

```
npm run typecheck
npm test
npm run build
```

If one fails, stop and report the failure. Do not open a PR on a red branch.

If the change can affect speed and the commits carry no `Perf` block, say so and ask for a measurement before going on.

## 3. Write the PR

Title: same format as a commit, `type(scope): summary`.

Body, in this order, with these exact headings:

```
## Summary
<1-2 lines: the root cause, or the need>
<1-2 lines: the fix, or what was added>

## Details
<how it works, why this approach, what was rejected and why>

## Performance
<dataset>
  frame  4.1 ms -> 3.2 ms
  p95    6.0 ms -> 4.4 ms

## Verification
- [x] typecheck
- [x] tests
- [x] build
```

- For a change that cannot affect speed, `## Performance` reads `No impact.`
- For a breaking change, add `## Breaking` after `## Summary` and say what breaks and how to migrate.
- Keep `Summary` short. The detail goes in `Details`.

## 4. Propose

Show the title and body to the user and ask `Open this PR? [Y/n]`.

On `Y`:

- If the branch is not on the remote, give the user the push command and wait. Do not push.
- Once it is on the remote, run `gh pr create --base dev --title "<title>" --body-file <file>`, then share the PR link.

On `n`, change what the user asks and propose again.
