// Prompt content for a Claude Code session asked to take a Shortcut story
// from "Ready" to a shipped PR. The spawned session has full skill access,
// so we defer to the operator's `shortcut-to-pr` skill (or equivalent) for
// the actual workflow — this prompt just hands off the story context and
// the worktree path.

export function buildStoryPrompt(event, worktreeDir, { repo, baseRef, postComments }) {
  const postLine = postComments
    ? `When the PR is open, follow the operator's normal posting policy (the standard '🤖 Posted by Claude' attribution block from AGENTS.md applies to any GitHub comments you post).`
    : `Do NOT post any GitHub comments (POST_COMMENTS=false in this environment) — open the PR but skip incidental comments.`;
  return [
    `You are taking Shortcut story sc-${event.storyId} from "Ready" to a shipped PR.`,
    ``,
    `Story: ${event.storyName}`,
    `Type: ${event.storyType}`,
    `Iteration: ${event.iterationName}`,
    `Shortcut URL: ${event.appUrl}`,
    ``,
    `Worktree: ${worktreeDir}`,
    `Repo: ${repo}  Base branch: ${baseRef}`,
    ``,
    `OPERATE FROM A DETACHED HEAD until you create your feature branch. The user may have other branches checked out in their main clone — never 'git switch' a branch that might be checked out elsewhere.`,
    ``,
    `WORKFLOW`,
    `1. cd ${worktreeDir}`,
    `2. Use the operator's "shortcut-to-pr" skill if it exists in your skill list — it covers the full lifecycle (fetch story, plan, implement, tests, screenshots, open PR). Invoke it with the story ID ${event.storyId}.`,
    `3. **Before settling on the base branch, check whether you should stack on an existing open PR.** Run \`gh pr list --author @me --state open --repo ${repo} --json number,title,headRefName,baseRefName,body,updatedAt,files\` and look for an unmerged PR whose work this story depends on or naturally extends (file overlap, same epic, requires unmerged model/service/feature flag, etc.). If yes, branch from \`origin/<that-headRefName>\` instead of \`origin/${baseRef}\` and open the new PR with \`--base <that-headRefName>\`. Note the dependency in the PR body's "PR Stack" section. If unsure, default to origin/${baseRef} and surface the candidate parent PR(s) in your plan as an open question.`,
    `4. If the skill is not available, fall back to: fetch the story details via the Shortcut MCP tools, plan the changes (including the stacking decision in step 3), create a branch named like '<your-mention>/sc-${event.storyId}/<slug>', implement + test, push, and open a PR with title containing '[sc-${event.storyId}]'.`,
    `5. ${postLine}`,
    ``,
    `IMPORTANT GUARDRAILS`,
    `- This pane was launched by the pr-watcher daemon. The operator can see it but isn't actively driving — you should make reasonable assumptions and proceed, but STOP and surface a question if anything is destructive, ambiguous, or beyond the story's scope.`,
    `- Never use --no-verify, --force (without --force-with-lease), or skip CI/hooks.`,
    `- Don't merge the PR yourself — opening it is the goal.`,
  ].join('\n');
}
