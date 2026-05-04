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

export async function setupWorktree({ projectRoot, gh, event }) {
  const { cloneDir, worktreeDir } = paths(projectRoot, event);
  await mkdir(dirname(cloneDir), { recursive: true });
  if (!existsSync(join(cloneDir, '.git'))) {
    log.info(`cloning ${event.repo} -> ${cloneDir} (one-time, may take a while)`);
    await gh(['repo', 'clone', event.repo, cloneDir, '--', '--filter=blob:none'], { json: false });
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
  await git(['checkout', '-B', event.headRefName], worktreeDir);
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
