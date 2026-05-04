---
name: triage-pr-activity
description: Triage one piece of activity (CI failure, issue comment, or review comment) on the operator's PR
---

You will be given one event in `args`. Possible shapes:

```jsonc
// CI failure
{
  "kind": "ci_failure",
  "repo": "owner/name",
  "pr": 123,
  "checkRunId": 456,
  "checkName": "build / lint",
  "headSha": "abc123",
}

// Issue comment on a PR
{
  "kind": "issue_comment",
  "repo": "owner/name",
  "pr": 123,
  "commentId": 789,
  "author": "alice",
  "body": "...",
}

// PR review comment (inline)
{
  "kind": "review_comment",
  "repo": "owner/name",
  "pr": 123,
  "commentId": 789,
  "author": "alice",
  "body": "...",
  "path": "src/foo.ts",
  "line": 42,
}
```

## What to do

1. **Pull context** with the `gh` command:
   - For CI failures: `gh run view <runId> --log-failed --repo <repo>` (use the workflow run id linked from the check run; you may need `gh api repos/<repo>/check-runs/<checkRunId>` first).
   - For comments: `gh pr view <pr> --repo <repo> --json title,body,headRefName` and `gh api repos/<repo>/issues/<pr>/comments` (or `.../pulls/<pr>/comments` for review comments) to see the surrounding thread.
2. **Decide whether to reply.** Skip purely informational chatter (LGTM, thanks, emoji reactions). Skip threads where a `🤖 Posted by Claude` reply already exists.
3. **Draft the reply** following the operator's tone (see AGENTS.md). For CI failures, lead with the root cause and link to the failing file:line.
4. **For CI failures, judge whether the failure is caused by changes in this PR's diff.**
   - Compare the failing file:line to the PR's diff (`gh pr diff <pr> --repo <repo>`).
   - `relatedToChanges = true` if the failure is plausibly caused by code this PR added/changed (e.g. a test the PR introduced, or behavior tied to a file the PR modified).
   - `relatedToChanges = false` if the failure is pre-existing, flaky, environmental, or otherwise unrelated to the diff (e.g. unrelated test, mock isolation bleed, infrastructure timeout, base-branch breakage).
   - `relatedToChanges = null` if you cannot tell with reasonable confidence.

   This verdict is consumed by the daemon to decide whether to attempt a rebase as the next action — be conservative with `false` (reserve it for failures you're confident don't touch the PR's diff).
5. **Post or stage:**
   - If `$POST_COMMENTS == "true"`: post via `gh pr comment <pr> --repo <repo> --body "<reply>"` (or the equivalent review-comment API). Always prepend the attribution block from AGENTS.md.
   - Otherwise: return the drafted reply in the result without posting.

## Result shape

Return:

```jsonc
{
  "skipped": boolean,                       // true if no reply was warranted
  "reason": string,                         // why you skipped, or short summary of what you did
  "draft": string | null,                   // the drafted reply (with attribution block), or null if skipped
  "posted": boolean,                        // true if you actually posted; false in dry-run mode
  "ciSummary": string | null,               // for ci_failure events: one-sentence root cause
  "relatedToChanges": boolean | null,       // for ci_failure events only: true=caused by this PR's diff, false=unrelated/preexisting, null=unsure
}
```
