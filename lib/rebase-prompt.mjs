// Prompt content for a Claude Code session asked to rebase / resolve a PR
// (and walk up the stack first if the PR is stacked on another behind PR).
// Lives in its own module so that pane-delegation only deals with HOW to spawn
// a pane and this module defines WHAT the agent in the pane should do.

export function buildRebasePrompt(event, worktreeDir, { postComments }) {
  const action = event.kind === 'merge_conflict'
    ? `Resolve the merge conflicts that appear when rebasing onto origin/${event.baseRefName}.`
    : `Rebase this branch onto origin/${event.baseRefName} (no conflicts expected).`;
  const postLine = postComments
    ? `When the push succeeds, post a brief confirmation comment on PR #${event.pr} with 'gh pr comment ${event.pr} --repo ${event.repo} --body "..."'. Prepend the standard '🤖 Posted by Claude' attribution block from AGENTS.md.`
    : `Do NOT post any GitHub comment (POST_COMMENTS=false in this environment).`;
  return [
    `Worktree: ${worktreeDir}`,
    `Repo: ${event.repo}  PR: #${event.pr}  Branch: ${event.headRefName}  Base: ${event.baseRefName}  Expected head: ${event.headSha}`,
    ``,
    `OPERATE FROM A DETACHED HEAD throughout. Branches may be checked out in other worktrees by the operator. Use 'git checkout --detach origin/<ref>' instead of 'git checkout <branch>' or 'git switch <branch>'. All rebase + push operations work fine detached; pushes are explicit (HEAD:<branch>).`,
    ``,
    `STACK AWARENESS — do this BEFORE rebasing this PR. This PR's base is '${event.baseRefName}'. If '${event.baseRefName}' is itself the head branch of another open PR by the operator, this PR is stacked. Detect with:`,
    ``,
    `    gh pr list --repo ${event.repo} --head ${event.baseRefName} --state open --author @me --json number,headRefName,baseRefName,headRefOid,mergeStateStatus`,
    ``,
    `If a parent PR is returned and its mergeStateStatus is BEHIND, you MUST update the parent first — otherwise this PR's rebase will land on a stale parent. Walk up: repeat the same query with the parent's baseRefName as --head, until you hit a non-PR base (the repo's default branch) or a parent that is not BEHIND. Then rebase from the topmost-BEHIND ancestor downward, force-pushing each level with '--force-with-lease=<branch>:<expected-sha>' before moving to the next. For each ancestor rebase, reuse this worktree: 'git fetch --prune origin <parent-base> <parent-head>', 'git checkout --detach origin/<parent-head>', resolve as below, then push. Only after all needed parent rebases succeed do you proceed to step 1 below for THIS PR.`,
    ``,
    `Steps for THIS PR (after any needed parent rebases):`,
    `1. cd ${worktreeDir}`,
    `2. git fetch --prune origin ${event.baseRefName} ${event.headRefName}`,
    `3. git checkout --detach origin/${event.headRefName}   (in case you moved during parent rebases)`,
    `4. git rebase origin/${event.baseRefName}`,
    `5. ${action} For each conflicted file: read both sides, only resolve when intent is clear, 'git add <file>'. If intent is ambiguous, run 'git rebase --abort' and stop — do NOT guess.`,
    `6. If a fast typecheck exists (tsc --noEmit, yarn ts:check, cargo check), run it. If it fails, abort and stop.`,
    `7. 'git rebase --continue' until clean.`,
    `8. Push without asking: git push --force-with-lease=${event.headRefName}:${event.headSha} origin HEAD:${event.headRefName}`,
    `9. ${postLine}`,
    ``,
    `If anything is risky or ambiguous, STOP. The operator can see this pane.`,
  ].join('\n');
}
