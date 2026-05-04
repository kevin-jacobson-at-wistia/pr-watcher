import { spawn, execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './gh-client.mjs';
import { log } from './log.mjs';

export function detectPaneHost(envValue = process.env.OPEN_IN_PANE) {
  const setting = (envValue ?? 'auto').toLowerCase();
  if (setting === 'never') return null;
  const inTmux = !!process.env.TMUX;
  const itermInstalled = existsSync('/Applications/iTerm.app');
  if (setting === 'tmux') return inTmux ? 'tmux' : null;
  if (setting === 'iterm') return itermInstalled ? 'iterm' : null;
  if (inTmux) return 'tmux';
  if (itermInstalled) return 'iterm';
  return null;
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function applescriptString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function paths(projectRoot, event) {
  const slug = event.repo.replace('/', '__');
  const cloneDir = join(projectRoot, 'git', slug, 'main');
  const shortSha = event.headSha.slice(0, 8);
  const worktreeDir = join(projectRoot, 'git', slug, `wt-pr-${event.pr}-${shortSha}`);
  return { slug, cloneDir, worktreeDir };
}

function remoteMatchesRepo(url, repo) {
  const norm = url.replace(/\.git$/, '').toLowerCase();
  const target = repo.toLowerCase();
  return norm.endsWith(`/${target}`) || norm.endsWith(`:${target}`);
}

async function findExistingClone(projectRoot, event) {
  const [owner, name] = event.repo.split('/');
  const parent = dirname(projectRoot);
  const grandparent = dirname(parent);
  const candidates = [
    join(parent, name),                  // ../wistia          for wistia/wistia
    join(grandparent, owner, name),      // ../../wistia/wistia
    join(grandparent, name),             // ../../wistia       (less common)
  ];
  for (const path of candidates) {
    if (!existsSync(join(path, '.git'))) continue;
    try {
      const url = await git(['remote', 'get-url', 'origin'], path);
      if (remoteMatchesRepo(url, event.repo)) return path;
    } catch { /* not a git repo / no origin — skip */ }
  }
  return null;
}

export async function setupWorktree({ projectRoot, gh, event }) {
  const { worktreeDir } = paths(projectRoot, event);
  let cloneDir = await findExistingClone(projectRoot, event);

  if (cloneDir) {
    log.info(`reusing existing clone for ${event.repo} at ${cloneDir}`);
  } else {
    cloneDir = paths(projectRoot, event).cloneDir;
    await mkdir(dirname(cloneDir), { recursive: true });
    if (!existsSync(join(cloneDir, '.git'))) {
      log.info(`cloning ${event.repo} -> ${cloneDir} (one-time, may take a while)`);
      await gh(['repo', 'clone', event.repo, cloneDir, '--', '--filter=blob:none'], { json: false });
    }
  }

  await git(['fetch', '--prune', 'origin', event.baseRefName, event.headRefName], cloneDir);

  await git(['worktree', 'remove', '--force', worktreeDir], cloneDir).catch(() => {});
  if (existsSync(worktreeDir)) {
    await new Promise((res, rej) => {
      const rm = spawn('rm', ['-rf', worktreeDir], { stdio: 'inherit' });
      rm.on('close', (c) => c === 0 ? res() : rej(new Error(`rm -rf failed (${c})`)));
    });
  }
  await git(['worktree', 'add', '--detach', worktreeDir, `origin/${event.headRefName}`], cloneDir);
  return { cloneDir, worktreeDir };
}

export function isClaudeRunningFor(worktreeDir) {
  try {
    const out = execSync(`pgrep -af 'claude' 2>/dev/null || true`, { encoding: 'utf8' });
    return out.split('\n').some((line) => line.includes(worktreeDir));
  } catch {
    return false;
  }
}

export async function reconcileDelegated({ store, gh }) {
  for (const entry of store.listDelegated()) {
    const { key, repo, data } = entry;
    const { headRefName, headSha, worktreeDir } = data;
    let remoteSha = null;
    try {
      const out = await gh(
        ['api', `repos/${repo}/git/ref/heads/${encodeURIComponent(headRefName)}`, '--jq', '.object.sha'],
        { json: false },
      );
      remoteSha = out.trim();
    } catch (err) {
      log.debug(`reconcile ${key}: could not fetch remote head (${err.message})`);
    }

    const wtExists = existsSync(worktreeDir);
    const claudeAlive = isClaudeRunningFor(worktreeDir);
    const ageMin = Math.round((Date.now() - entry.at) / 60000);

    if (remoteSha && remoteSha !== headSha) {
      log.info(`reconcile ${key}: head moved (${headSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}); marking complete`);
      store.markHandled(key, {
        kind: entry.kind, repo, pr: entry.pr,
        data: { ...data, result: 'delegated-and-completed', pushedSha: remoteSha },
      });
      continue;
    }
    if (!claudeAlive && (!wtExists || ageMin > 5)) {
      log.info(`reconcile ${key}: claude gone${wtExists ? ' but worktree remains' : ''} (${ageMin}m); orphaned, will retry`);
      store.remove(key);
      continue;
    }
    if (claudeAlive && ageMin > 60) {
      log.info(`reconcile ${key}: still in progress after ${ageMin}m — long-running, leaving alone`);
    } else {
      log.debug(`reconcile ${key}: in progress (${ageMin}m, claude=${claudeAlive}, wt=${wtExists})`);
    }
  }
}

export function buildClaudePrompt(event, worktreeDir, { postComments }) {
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
    `IMPORTANT: this worktree is intentionally on a DETACHED HEAD. The branch ${event.headRefName} is checked out elsewhere in the operator's setup, so we can't 'git checkout' it here. Don't run 'git checkout <branch>' or 'git switch <branch>'. All rebase + push operations work fine from a detached HEAD; the final push pushes HEAD to the remote ref explicitly.`,
    ``,
    `Steps:`,
    `1. cd ${worktreeDir}`,
    `2. git rebase origin/${event.baseRefName}`,
    `3. ${action} For each conflicted file: read both sides, only resolve when intent is clear, 'git add <file>'. If intent is ambiguous, run 'git rebase --abort' and stop — do NOT guess.`,
    `4. If a fast typecheck exists (tsc --noEmit, yarn ts:check, cargo check), run it. If it fails, abort and stop.`,
    `5. 'git rebase --continue' until clean.`,
    `6. Push without asking: git push --force-with-lease=${event.headRefName}:${event.headSha} origin HEAD:${event.headRefName}`,
    `7. ${postLine}`,
    ``,
    `If anything is risky or ambiguous, STOP. The operator can see this pane.`,
  ].join('\n');
}

function spawnInTmux(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', ['split-window', '-h', command], { stdio: 'inherit' });
    child.on('close', (c) => c === 0 ? resolve() : reject(new Error(`tmux split-window exited ${c}`)));
    child.on('error', reject);
  });
}

function spawnInIterm(command) {
  const inIterm = process.env.TERM_PROGRAM === 'iTerm.app';
  const script = inIterm
    ? `tell application "iTerm"
         tell current window
           tell current session
             set newSession to (split horizontally with default profile)
             tell newSession
               write text ${applescriptString(command)}
             end tell
           end tell
         end tell
       end tell`
    : `tell application "iTerm"
         activate
         if (count of windows) = 0 then
           create window with default profile
         else
           tell current window to create tab with default profile
         end if
         tell current session of current window
           write text ${applescriptString(command)}
         end tell
       end tell`;
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], { stdio: 'inherit' });
    child.on('close', (c) => c === 0 ? resolve() : reject(new Error(`osascript exited ${c}`)));
    child.on('error', reject);
  });
}

export async function delegateToPane({ projectRoot, gh, event, host, postComments }) {
  const { worktreeDir } = await setupWorktree({ projectRoot, gh, event });
  const prompt = buildClaudePrompt(event, worktreeDir, { postComments });
  const inner = `cd ${shellQuote(worktreeDir)} && claude --dangerously-skip-permissions ${shellQuote(prompt)}; echo; echo '[claude done — press enter to close]'; read -r`;
  if (host === 'tmux') await spawnInTmux(inner);
  else await spawnInIterm(inner);
  return { worktreeDir };
}
