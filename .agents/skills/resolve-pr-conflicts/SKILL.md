---
name: resolve-pr-conflicts
description: Rebase a PR against its base, resolving conflicts when present. Uses worktrees off a persistent local clone.
---

You will be given an event in `args` with these fields:

```jsonc
{
  "kind": "branch_behind" | "merge_conflict",
  "repo": "owner/name",
  "pr": 123,
  "headRefName": "feature-x",
  "headSha": "abc123def456...",
  "baseRefName": "main",
  "baseSha": "789...",
  "mode": "rebase-only" | "resolve-conflicts",

  // Pre-computed absolute paths — USE THESE EXACTLY. Do not invent your own.
  "projectRoot": "/abs/path/to/pr-watcher",
  "cloneDir":    "/abs/path/to/pr-watcher/git/<slug>/main",
  "worktreeDir": "/abs/path/to/pr-watcher/git/<slug>/wt-pr-<num>-<shortsha>",
  "slug":        "owner__name"
}
```

- `mode: "rebase-only"` — branch is BEHIND but has no conflicts. Just rebase against the base and force-push. **Do not invent code changes.**
- `mode: "resolve-conflicts"` — branch is DIRTY. Attempt to resolve each conflicted file. Push only if resolution is high-confidence.

The agent has access to `git` and `gh`. The operator's flags `AUTO_REBASE` / `RESOLVE_CONFLICTS` were already checked before this skill ran — if you're here, you're authorized to do the work.

## Path discipline — read this first

You MUST use the absolute paths from `args`:

- All clones go to **exactly** `args.cloneDir`. Never `/tmp/...`, never any other path you make up.
- All worktrees go to **exactly** `args.worktreeDir`.
- Before running any command, verify with `pwd` and adjust if needed. The sandbox cwd is not guaranteed.

If a command insists on a different path, **abort** with `outcome: "could-not-resolve"` and a `reason` that explains why. Do not improvise a path.

## Procedure

### 1. Ensure the persistent clone exists and is fresh

Pull the absolute paths and refs from `args`:

```bash
CLONE="$args_cloneDir"
BASE_REF="$args_baseRefName"
HEAD_REF="$args_headRefName"
REPO="$args_repo"

mkdir -p "$(dirname "$CLONE")"

if [ ! -d "$CLONE/.git" ]; then
  gh repo clone "$REPO" "$CLONE" -- --filter=blob:none
fi

git -C "$CLONE" fetch --prune origin "$BASE_REF" "$HEAD_REF"
```

(In practice you'll inline the actual values from `args` — the `$args_*` syntax above is for clarity. Substitute the real strings.)

The `--filter=blob:none` keeps the initial clone fast for large repos by deferring blob fetches.

If `gh repo clone` fails with an auth error: the operator hasn't run `gh auth setup-git`. Bail with `outcome: "could-not-resolve"` and a `reason` that says so explicitly.

### 2. Create a fresh worktree

```bash
WT="$args_worktreeDir"

# Clean up any stale worktree from a prior failed run.
git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
rm -rf "$WT"

git -C "$CLONE" worktree add --detach "$WT" "origin/$HEAD_REF"
cd "$WT"
git checkout -B "$HEAD_REF"
```

After `cd "$WT"`, run `pwd` to confirm you are in the worktree. If `pwd` doesn't match `$args_worktreeDir`, abort with `outcome: "could-not-resolve"`.

### 3. Attempt the rebase

```bash
git rebase "origin/$BASE_REF"
```

- **No conflicts** (rebase succeeds): jump to step 5 (push).
- **Conflicts** (rebase pauses): `git status` will show conflicted files. If `mode == "rebase-only"`, **abort** the rebase (`git rebase --abort`) and return `outcome: "could-not-resolve"`, `reason: "branch was reported as BEHIND but rebase produced conflicts; manual review needed"`. Don't try to resolve — the operator only opted in to clean rebases.

### 4. Resolve conflicts (only when `mode == "resolve-conflicts"`)

For each conflicted file:

1. Read the file. The conflict markers are `<<<<<<<`, `=======`, `>>>>>>>`.
2. Examine both sides. Use `git log --oneline origin/$BASE_REF..HEAD -- <file>` and `git log --oneline HEAD..origin/$BASE_REF -- <file>` to understand intent.
3. **Only resolve when intent is clear.** Examples of clear intent:
   - One side adds an import, the other adds a different import to the same block — keep both.
   - One side renames a function call to match a refactor on the other side — apply the rename.
   - Whitespace / formatting differences — pick the side that matches the project style.
4. **Bail when intent is ambiguous.** If two changes touch the same logical line with different semantics, don't guess. `git rebase --abort`, return `outcome: "could-not-resolve"` with a `reason` listing the files you couldn't reconcile.
5. After resolving a file: `git add <file>`.

Once all files are resolved: `git rebase --continue`. Loop if more commits conflict.

If the project has tests or a typecheck that runs quickly (e.g. `tsc --noEmit`, `cargo check`) and you can detect the project type from `package.json` / `Cargo.toml` / etc., run it now. If it fails, **abort** and return `outcome: "could-not-resolve"` with the failure output in `reason`. Do not push code that you broke.

### 5. Push (or stage)

When the rebase is clean, force-push **with lease**:

```bash
git push --force-with-lease="$HEAD_REF:$args_headSha" origin "HEAD:$HEAD_REF"
```

The `--force-with-lease=$HEAD_REF:$args_headSha` makes the push fail if the remote has moved since you started — you won't trample new commits the operator pushed.

If the push succeeds: capture the new sha (`git rev-parse HEAD`) into `pushedSha`. Then post a comment confirming the action, with the standard attribution block (see AGENTS.md). Comment body example:

```markdown
Rebased onto `<baseRefName>` and force-pushed. New head: `<new-sha-short>`.

<list of conflicts you resolved, if any, with one-line each>
```

If `POST_COMMENTS != "true"`, set `posted: false` and put the would-be comment in `draft`. **The push still happens** — that's the whole point of the operator opting into AUTO_REBASE / RESOLVE_CONFLICTS. POST_COMMENTS only gates the explanatory comment, not the push.

### 6. Clean up the worktree

Always run, even on failure:

```bash
cd "$args_projectRoot"
git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
rm -rf "$WT"
```

The persistent clone (`$CLONE`) stays — it's reused by the next event on the same repo.

## Result shape

Return:

```jsonc
{
  "skipped": boolean,
  "reason": string,
  "outcome": "rebased-and-pushed" | "conflicts-resolved-and-pushed"
           | "rebased-locally-not-pushed" | "drafted-resolution-not-pushed"
           | "could-not-resolve" | "no-op",
  "pushedSha": string | null,           // new HEAD sha if pushed
  "conflictedFiles": string[],          // files you resolved (or tried to)
  "draft": string | null,               // confirmation comment (with attribution)
  "posted": boolean                     // true only if you actually posted via gh
}
```

## Hard rules — recap

- **Use `args.cloneDir` and `args.worktreeDir` exactly.** Never invent paths under `/tmp` or anywhere else.
- **`pwd` after every `cd`.** If it's not where you expected, abort.
- **Never `--force` without lease.** Only `--force-with-lease=<ref>:<expected-sha>`.
- **Bail loudly when in doubt.** `outcome: "could-not-resolve"` with a clear `reason` is always better than guessing on production code.
