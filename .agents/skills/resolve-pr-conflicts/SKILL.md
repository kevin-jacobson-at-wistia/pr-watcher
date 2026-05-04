---
name: resolve-pr-conflicts
description: Rebase a PR against its base, resolving conflicts when present. Uses worktrees off a persistent local clone.
---

You will be given an event in `args` that looks like:

```jsonc
{
  "kind": "branch_behind" | "merge_conflict",
  "repo": "owner/name",
  "pr": 123,
  "headRefName": "feature-x",
  "headSha": "abc123",
  "baseRefName": "main",
  "baseSha": "def456",
  "mode": "rebase-only" | "resolve-conflicts"
}
```

- `mode: "rebase-only"` — branch is BEHIND but has no conflicts. Just rebase against the base and force-push. **Do not invent code changes.**
- `mode: "resolve-conflicts"` — branch is DIRTY. Attempt to resolve each conflicted file. Push only if resolution is high-confidence.

The agent is allowed `git` and `gh`. The operator's flags `AUTO_REBASE` / `RESOLVE_CONFLICTS` were already checked before this skill ran — if you're here, you're authorized to do the work.

## Repository layout

You are running with the project root mounted at `/workspace` (Flue's local sandbox). All git operations happen under `/workspace/git/`:

- **Persistent clone** — `/workspace/git/<owner>__<name>/main/` is a normal clone of the repo. Reused across events; you fetch into it instead of re-cloning. The slug uses `__` as a path-safe separator (e.g. `wistia__wistia`).
- **Per-event worktree** — `/workspace/git/<owner>__<name>/wt-pr-<num>-<shortsha>/` is a fresh worktree for this rebase attempt. Created at the start, removed at the end (success or failure).

## Procedure

### 1. Ensure the persistent clone exists and is fresh

```bash
SLUG="${repo//\//__}"             # owner/name -> owner__name
CLONE="/workspace/git/$SLUG/main"

if [ ! -d "$CLONE/.git" ]; then
  mkdir -p "/workspace/git/$SLUG"
  gh repo clone "$repo" "$CLONE" -- --filter=blob:none
fi

git -C "$CLONE" fetch --prune origin "$baseRefName" "$headRefName"
```

The `--filter=blob:none` keeps the initial clone fast for large repos by deferring blob fetches.

If `gh repo clone` fails with an auth error: the operator may not have `gh auth setup-git` configured. Bail with `outcome: "could-not-resolve"` and a `reason` that says so explicitly.

### 2. Create a fresh worktree

```bash
SHORT="$(printf '%s' "$headSha" | cut -c1-8)"
WT="/workspace/git/$SLUG/wt-pr-${pr}-${SHORT}"

# Clean up any stale worktree from a prior failed run.
git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
rm -rf "$WT"

git -C "$CLONE" worktree add --detach "$WT" "origin/$headRefName"
cd "$WT"
git checkout -B "$headRefName"
```

### 3. Attempt the rebase

```bash
git rebase "origin/$baseRefName"
```

- **No conflicts** (rebase succeeds): jump to step 5 (push).
- **Conflicts** (rebase pauses): `git status` will show conflicted files. If `mode == "rebase-only"`, **abort** the rebase and skip with `outcome: "could-not-resolve"`, `reason: "branch was reported as BEHIND but rebase produced conflicts; manual review needed"`. Don't try to resolve — the operator only opted in to clean rebases.

### 4. Resolve conflicts (only when `mode == "resolve-conflicts"`)

For each conflicted file:

1. Read the file. The conflict markers are `<<<<<<<`, `=======`, `>>>>>>>`.
2. Examine both sides. Use `git log --oneline origin/$baseRefName..HEAD -- <file>` and `git log --oneline HEAD..origin/$baseRefName -- <file>` to understand intent.
3. **Only resolve when intent is clear.** Examples of clear intent:
   - One side adds an import, the other side adds a different import to the same block — keep both.
   - One side renames a function call to match a refactor on the other side — apply the rename.
   - Whitespace / formatting differences — pick the side that matches the project style.
4. **Bail when intent is ambiguous.** If two changes touch the same logical line with different semantics, don't guess. Stop, abort the rebase, and return `outcome: "could-not-resolve"` with a `reason` listing the files you couldn't reconcile.
5. After resolving a file: `git add <file>`.

Once all files are resolved: `git rebase --continue`. Loop if more commits conflict.

If the project has tests or a typecheck that runs quickly (e.g. `tsc --noEmit`, `cargo check`), and you can detect the project type from `package.json` / `Cargo.toml` / etc., run it now. If it fails, abort and return `outcome: "could-not-resolve"` with the failure output in `reason`.

### 5. Push (or stage)

When the rebase is clean, force-push **with lease**:

```bash
git push --force-with-lease=$headRefName:$headSha origin "HEAD:$headRefName"
```

The `--force-with-lease=$headRefName:$headSha` makes the push fail if the remote has moved since you started — you won't trample new commits the operator pushed.

If the push succeeds: post a comment confirming the action with the standard attribution block (see AGENTS.md). Comment body example:

```markdown
Rebased onto `<baseRefName>` and force-pushed. New head: `<new-sha-short>`.

<list of conflicts you resolved, if any, with one-line each>
```

If `POST_COMMENTS != "true"`, set `posted: false` and put the would-be comment in `draft`. The push still happens — that's the whole point of the operator opting into AUTO_REBASE / RESOLVE_CONFLICTS.

### 6. Clean up the worktree

Always run, even on failure:

```bash
cd /workspace
git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
rm -rf "$WT"
```

The persistent clone stays.

## Result shape

```jsonc
{
  "skipped": boolean,
  "reason": string,
  "outcome": "rebased-and-pushed" | "conflicts-resolved-and-pushed"
           | "rebased-locally-not-pushed" | "drafted-resolution-not-pushed"
           | "could-not-resolve" | "no-op",
  "pushedSha": string | null,           // the new HEAD sha if pushed
  "conflictedFiles": string[],          // files you resolved (or tried to)
  "draft": string | null,               // confirmation comment (with attribution)
  "posted": boolean                     // true only if you actually posted via gh
}
```
