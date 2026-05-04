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

const LOG_LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };
const LOG_LEVEL_NAME = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const LOG_LEVEL = LOG_LEVELS[LOG_LEVEL_NAME] ?? LOG_LEVELS.info;

const ts = () => new Date().toISOString();
const log = {
  error: (msg) => { if (LOG_LEVEL >= LOG_LEVELS.error) console.error(`[${ts()}] ERROR ${msg}`); },
  info:  (msg) => { if (LOG_LEVEL >= LOG_LEVELS.info)  console.log(`[${ts()}] INFO  ${msg}`); },
  debug: (msg) => { if (LOG_LEVEL >= LOG_LEVELS.debug) console.log(`[${ts()}] DEBUG ${msg}`); },
};

if (!USERNAME) {
  log.error('GITHUB_USERNAME is required (set it in .env or your shell).');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  log.error('ANTHROPIC_API_KEY is required.');
  process.exit(1);
}
if (!(LOG_LEVEL_NAME in LOG_LEVELS)) {
  log.error(`unknown LOG_LEVEL "${LOG_LEVEL_NAME}". Valid: ${Object.keys(LOG_LEVELS).join(', ')}. Falling back to info.`);
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
    '--json', 'repository,number,title,updatedAt',
  ]);
}

async function fetchPRDetail(repo, pr) {
  const [meta, comments, reviewComments] = await Promise.all([
    gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,headRefName,baseRefName,baseRefOid,mergeable,mergeStateStatus']),
    gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate']),
    gh(['api', `repos/${repo}/pulls/${pr}/comments`, '--paginate']),
  ]);
  return {
    headRefOid: meta.headRefOid,
    headRefName: meta.headRefName,
    baseRefName: meta.baseRefName,
    baseRefOid: meta.baseRefOid,
    mergeable: meta.mergeable,
    mergeStateStatus: meta.mergeStateStatus,
    comments,
    reviewComments,
  };
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

function eventKey(event) {
  switch (event.kind) {
    case 'issue_comment':
    case 'review_comment':
      return makeKey(event.kind, event.repo, event.commentId);
    case 'ci_failure':
      return makeKey(event.kind, event.repo, event.checkRunId);
    case 'branch_behind':
    case 'merge_conflict':
      return makeKey(event.kind, event.repo, `${event.pr}:${event.headSha}:${event.baseSha}`);
    default:
      return makeKey(event.kind, event.repo, event.pr);
  }
}

async function runAgentForEvent(event) {
  return new Promise((resolve, reject) => {
    const id = `pr-watcher-${event.kind}-${event.repo.replace('/', '_')}-${event.pr}`;
    const passthrough = LOG_LEVEL >= LOG_LEVELS.debug;
    const child = spawn(
      'npx',
      ['flue', 'run', 'watch', '--target', 'node', '--id', id, '--payload', JSON.stringify(event)],
      {
        cwd: projectRoot,
        env: { ...process.env, POST_COMMENTS: POST_COMMENTS ? 'true' : 'false' },
        stdio: ['ignore', 'pipe', passthrough ? 'inherit' : 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      if (passthrough) process.stdout.write(d);
      stdout += d;
    });
    if (!passthrough && child.stderr) {
      child.stderr.on('data', (d) => (stderr += d));
    }
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = passthrough ? '' : `\n--- flue stderr ---\n${stderr}`;
        return reject(new Error(`flue run exited ${code}${detail}`));
      }
      const jsonOnly = stdout
        .split('\n')
        .filter((line) => !line.startsWith('[flue] '))
        .join('\n')
        .trim();
      try {
        resolve(JSON.parse(jsonOnly));
      } catch (err) {
        reject(new Error(`could not parse flue stdout as JSON: ${err.message}\nraw stdout was:\n${stdout}`));
      }
    });
    child.on('error', reject);
  });
}

function summarizeResult(event, result) {
  if (!result) return 'no result';
  const where = `${event.repo}#${event.pr}`;
  if (result.skipped) return `skipped ${event.kind} ${where} — ${result.reason}`;
  if (event.kind === 'branch_behind' || event.kind === 'merge_conflict') {
    const sha = result.pushedSha ? ` -> ${String(result.pushedSha).slice(0, 8)}` : '';
    const files = result.conflictedFiles?.length ? ` (resolved ${result.conflictedFiles.length} file(s))` : '';
    return `${event.kind} ${where}: ${result.outcome}${sha}${files}`;
  }
  if (event.kind === 'ci_failure' && result.ciSummary) {
    return `ci summary for ${where}: ${result.ciSummary}${result.posted ? ' (posted)' : ' (dry-run)'}`;
  }
  const draftLen = result.draft ? `${result.draft.length} chars` : 'no draft';
  return `drafted reply for ${event.kind} ${where} — ${draftLen}, posted=${result.posted}`;
}

async function tick(state) {
  const prs = await listOpenPRs();
  log.info(`scanning ${prs.length} open PR(s) by @${USERNAME}`);

  const events = [];

  for (const pr of prs) {
    const repo = `${pr.repository.nameWithOwner}`;
    const detail = await fetchPRDetail(repo, pr.number).catch((err) => {
      log.error(`failed to fetch ${repo}#${pr.number}: ${err.message}`);
      return null;
    });
    if (!detail) continue;
    log.debug(`${repo}#${pr.number}: ${detail.comments.length} issue comments, ${detail.reviewComments.length} review comments`);

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

    const checks = await fetchChecksForSha(repo, detail.headRefOid);
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
        headSha: detail.headRefOid,
      });
    }

    const mergePair = `${detail.headRefOid}:${detail.baseRefOid}`;
    if (detail.mergeStateStatus === 'BEHIND') {
      const key = makeKey('branch_behind', repo, `${pr.number}:${mergePair}`);
      if (!state.handled[key]) {
        events.push({
          kind: 'branch_behind',
          repo,
          pr: pr.number,
          headRefName: detail.headRefName,
          headSha: detail.headRefOid,
          baseRefName: detail.baseRefName,
          baseSha: detail.baseRefOid,
        });
      }
    } else if (detail.mergeStateStatus === 'DIRTY') {
      const key = makeKey('merge_conflict', repo, `${pr.number}:${mergePair}`);
      if (!state.handled[key]) {
        events.push({
          kind: 'merge_conflict',
          repo,
          pr: pr.number,
          headRefName: detail.headRefName,
          headSha: detail.headRefOid,
          baseRefName: detail.baseRefName,
          baseSha: detail.baseRefOid,
        });
      }
    }
  }

  log.info(`${events.length} new event(s) to process`);

  for (const event of events) {
    const key = eventKey(event);
    log.info(`-> ${event.kind} ${event.repo}#${event.pr}`);
    try {
      const result = await runAgentForEvent(event);
      log.info(summarizeResult(event, result));
      state.handled[key] = { at: Date.now(), result: result?.reason ?? 'ok' };
    } catch (err) {
      log.error(`agent failed for ${event.kind} ${event.repo}#${event.pr}: ${err.message}`);
    }
    await saveState(state);
  }

  state.lastScan = new Date().toISOString();
  await saveState(state);
}

async function main() {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const state = await loadState();
  log.info(
    `pr-watcher started. polling every ${POLL_MS / 1000}s. ` +
    `POST_COMMENTS=${POST_COMMENTS} ` +
    `AUTO_REBASE=${process.env.AUTO_REBASE === 'true'} ` +
    `RESOLVE_CONFLICTS=${process.env.RESOLVE_CONFLICTS === 'true'} ` +
    `LOG_LEVEL=${LOG_LEVEL_NAME}`
  );

  while (true) {
    const start = Date.now();
    try {
      await tick(state);
    } catch (err) {
      log.error(`tick failed: ${err.message}`);
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(0, POLL_MS - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((err) => {
  log.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
