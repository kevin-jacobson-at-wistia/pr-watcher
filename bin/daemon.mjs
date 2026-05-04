#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const STATE_PATH = join(projectRoot, 'state.json');

const POLL_MS = (Number(process.env.POLL_INTERVAL_SEC) || 120) * 1000;
const USERNAME = process.env.GITHUB_USERNAME;
const GH_TOKEN = process.env.GH_TOKEN;
const POST_COMMENTS = process.env.POST_COMMENTS === 'true';

if (!USERNAME) {
  console.error('GITHUB_USERNAME is required (set it in .env or your shell).');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required.');
  process.exit(1);
}

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { handled: {}, lastScan: null };
  }
  return JSON.parse(await readFile(STATE_PATH, 'utf8'));
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

function gh(args, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (GH_TOKEN) env.GH_TOKEN = GH_TOKEN;
    else delete env.GH_TOKEN;
    const child = spawn('gh', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`gh ${args.join(' ')} failed (${code}): ${stderr}`));
      resolve(json ? JSON.parse(stdout) : stdout);
    });
    child.on('error', reject);
  });
}

async function listOpenPRs() {
  return gh([
    'search', 'prs',
    '--author', USERNAME,
    '--state', 'open',
    '--limit', '50',
    '--json', 'repository,number,title,updatedAt,headRefOid',
  ]);
}

async function fetchPRDetail(repo, pr) {
  const comments = await gh([
    'api', `repos/${repo}/issues/${pr}/comments`, '--paginate',
  ]);
  const reviewComments = await gh([
    'api', `repos/${repo}/pulls/${pr}/comments`, '--paginate',
  ]);
  const checks = await gh([
    'api', `repos/${repo}/commits/HEAD/check-runs`,
    '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json',
  ]).catch(() => ({ check_runs: [] }));
  return { comments, reviewComments, checkRuns: checks.check_runs ?? [] };
}

async function fetchChecksForSha(repo, sha) {
  const data = await gh([
    'api', `repos/${repo}/commits/${sha}/check-runs`,
    '-H', 'Accept: application/vnd.github+json',
  ]).catch(() => ({ check_runs: [] }));
  return data.check_runs ?? [];
}

function makeKey(kind, repo, id) {
  return `${kind}:${repo}:${id}`;
}

async function runAgentForEvent(event) {
  return new Promise((resolve, reject) => {
    const id = `pr-watcher-${event.kind}-${event.repo.replace('/', '_')}-${event.pr}`;
    const child = spawn(
      'npx',
      ['flue', 'run', 'watch', '--target', 'node', '--id', id, '--payload', JSON.stringify(event)],
      {
        cwd: projectRoot,
        env: { ...process.env, POST_COMMENTS: POST_COMMENTS ? 'true' : 'false' },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let stdout = '';
    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      stdout += d;
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`flue run exited ${code}`));
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (err) {
        reject(err);
      }
    });
    child.on('error', reject);
  });
}

async function tick(state) {
  const prs = await listOpenPRs();
  console.log(`[${new Date().toISOString()}] scanning ${prs.length} open PR(s) by @${USERNAME}`);

  const events = [];

  for (const pr of prs) {
    const repo = `${pr.repository.nameWithOwner}`;
    const detail = await fetchPRDetail(repo, pr.number).catch((err) => {
      console.error(`  failed to fetch ${repo}#${pr.number}: ${err.message}`);
      return null;
    });
    if (!detail) continue;

    for (const c of detail.comments) {
      const key = makeKey('issue_comment', repo, c.id);
      if (state.handled[key]) continue;
      if (c.user?.login === USERNAME) {
        state.handled[key] = { at: Date.now(), skipped: 'self-authored' };
        continue;
      }
      events.push({
        kind: 'issue_comment',
        repo,
        pr: pr.number,
        commentId: c.id,
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
      });
    }

    for (const c of detail.reviewComments) {
      const key = makeKey('review_comment', repo, c.id);
      if (state.handled[key]) continue;
      if (c.user?.login === USERNAME) {
        state.handled[key] = { at: Date.now(), skipped: 'self-authored' };
        continue;
      }
      events.push({
        kind: 'review_comment',
        repo,
        pr: pr.number,
        commentId: c.id,
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        path: c.path ?? '',
        line: c.line ?? c.original_line ?? 0,
      });
    }

    const checks = await fetchChecksForSha(repo, pr.headRefOid);
    for (const cr of checks) {
      if (cr.conclusion !== 'failure') continue;
      const key = makeKey('ci_failure', repo, cr.id);
      if (state.handled[key]) continue;
      events.push({
        kind: 'ci_failure',
        repo,
        pr: pr.number,
        checkRunId: cr.id,
        checkName: cr.name,
        headSha: pr.headRefOid,
      });
    }
  }

  console.log(`  ${events.length} new event(s) to process`);

  for (const event of events) {
    const key = makeKey(event.kind, event.repo, event.commentId ?? event.checkRunId);
    console.log(`  -> ${event.kind} ${event.repo}#${event.pr}`);
    try {
      const result = await runAgentForEvent(event);
      state.handled[key] = { at: Date.now(), result: result?.reason ?? 'ok' };
    } catch (err) {
      console.error(`  agent failed: ${err.message}`);
    }
    await saveState(state);
  }

  state.lastScan = new Date().toISOString();
  await saveState(state);
}

async function main() {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const state = await loadState();
  console.log(`pr-watcher started. polling every ${POLL_MS / 1000}s. POST_COMMENTS=${POST_COMMENTS}`);

  while (true) {
    const start = Date.now();
    try {
      await tick(state);
    } catch (err) {
      console.error(`tick failed: ${err.message}`);
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(0, POLL_MS - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
