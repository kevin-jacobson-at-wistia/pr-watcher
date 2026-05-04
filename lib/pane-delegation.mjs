import { spawn, execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './gh-client.mjs';
import { log } from './log.mjs';
import { buildRebasePrompt } from './rebase-prompt.mjs';
import { buildStoryPrompt } from './story-prompt.mjs';

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

// For PR events the repo + worktree slug come from the event. For story events
// the daemon supplies `repo` (defaulted from STORY_TARGET_REPO).
export function paths(projectRoot, event, { repo: repoOverride } = {}) {
  const repo = repoOverride ?? event.repo;
  const slug = repo.replace('/', '__');
  const cloneDir = join(projectRoot, 'git', slug, 'main');
  let worktreeDir;
  if (event.kind === 'shortcut_story') {
    worktreeDir = join(projectRoot, 'git', slug, `wt-sc-${event.storyId}`);
  } else {
    const shortSha = event.headSha.slice(0, 8);
    worktreeDir = join(projectRoot, 'git', slug, `wt-pr-${event.pr}-${shortSha}`);
  }
  return { slug, cloneDir, worktreeDir, repo };
}

function remoteMatchesRepo(url, repo) {
  const norm = url.replace(/\.git$/, '').toLowerCase();
  const target = repo.toLowerCase();
  return norm.endsWith(`/${target}`) || norm.endsWith(`:${target}`);
}

async function findExistingClone(projectRoot, repo) {
  const [owner, name] = repo.split('/');
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
      if (remoteMatchesRepo(url, repo)) return path;
    } catch { /* not a git repo / no origin — skip */ }
  }
  return null;
}

export async function setupWorktree({ projectRoot, gh, event, repo: repoOverride, baseRef }) {
  const { worktreeDir, repo } = paths(projectRoot, event, { repo: repoOverride });
  let cloneDir = await findExistingClone(projectRoot, repo);

  if (cloneDir) {
    log.info(`reusing existing clone for ${repo} at ${cloneDir}`);
  } else {
    cloneDir = paths(projectRoot, event, { repo: repoOverride }).cloneDir;
    await mkdir(dirname(cloneDir), { recursive: true });
    if (!existsSync(join(cloneDir, '.git'))) {
      log.info(`cloning ${repo} -> ${cloneDir} (one-time, may take a while)`);
      await gh(['repo', 'clone', repo, cloneDir, '--', '--filter=blob:none'], { json: false });
    }
  }

  // Story events fetch only the base ref and start the worktree from it.
  // PR events fetch baseRef + headRef and start the worktree from headRef.
  const isStory = event.kind === 'shortcut_story';
  const startRef = isStory ? baseRef : event.headRefName;
  const fetchRefs = isStory ? [baseRef] : [event.baseRefName, event.headRefName];
  await git(['fetch', '--prune', 'origin', ...fetchRefs], cloneDir);

  await git(['worktree', 'remove', '--force', worktreeDir], cloneDir).catch(() => {});
  if (existsSync(worktreeDir)) {
    await new Promise((res, rej) => {
      const rm = spawn('rm', ['-rf', worktreeDir], { stdio: 'inherit' });
      rm.on('close', (c) => c === 0 ? res() : rej(new Error(`rm -rf failed (${c})`)));
    });
  }
  await git(['worktree', 'add', '--detach', worktreeDir, `origin/${startRef}`], cloneDir);
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
    const { key, kind, repo, data } = entry;
    const { headRefName, headSha, worktreeDir } = data;
    const wtExists = existsSync(worktreeDir);
    const claudeAlive = isClaudeRunningFor(worktreeDir);
    const ageMin = Math.round((Date.now() - entry.at) / 60000);

    // Story events have no pre-known remote ref to watch — completion is
    // signaled by claude exiting. Anything still alive is left in place.
    if (kind === 'shortcut_story') {
      if (!claudeAlive && (!wtExists || ageMin > 5)) {
        log.info(`reconcile ${key}: claude gone${wtExists ? ' but worktree remains' : ''} (${ageMin}m); marking complete`);
        store.markHandled(key, {
          kind, repo, pr: entry.pr,
          data: { ...data, result: 'delegated-and-completed' },
        });
      } else if (claudeAlive && ageMin > 60) {
        log.info(`reconcile ${key}: still in progress after ${ageMin}m — long-running, leaving alone`);
      } else {
        log.debug(`reconcile ${key}: in progress (${ageMin}m, claude=${claudeAlive}, wt=${wtExists})`);
      }
      continue;
    }

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

    if (remoteSha && remoteSha !== headSha) {
      log.info(`reconcile ${key}: head moved (${headSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}); marking complete`);
      store.markHandled(key, {
        kind, repo, pr: entry.pr,
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

export async function delegateToPane({ projectRoot, gh, event, host, postComments, repo, baseRef }) {
  const isStory = event.kind === 'shortcut_story';
  const setupOpts = isStory ? { repo, baseRef } : {};
  const { worktreeDir } = await setupWorktree({ projectRoot, gh, event, ...setupOpts });
  const prompt = isStory
    ? buildStoryPrompt(event, worktreeDir, { repo, baseRef, postComments })
    : buildRebasePrompt(event, worktreeDir, { postComments });
  const inner = `cd ${shellQuote(worktreeDir)} && claude --dangerously-skip-permissions ${shellQuote(prompt)}; echo; echo '[claude done — press enter to close]'; read -r`;
  if (host === 'tmux') await spawnInTmux(inner);
  else await spawnInIterm(inner);
  return { worktreeDir };
}
