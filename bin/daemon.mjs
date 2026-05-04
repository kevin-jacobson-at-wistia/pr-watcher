#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log, logLevelName, logLevelIsKnown, LOG_LEVELS } from '../lib/log.mjs';
import { Store, sortByPriority, eventKey } from '../lib/state.mjs';
import { makeGh } from '../lib/gh-client.mjs';
import {
  listOpenPRs, fetchPRDetail, fetchChecksForSha,
  buildEventsForPR, buildMergeEventForPR, buildCIEventsForPR,
} from '../lib/github-events.mjs';
import { runAgentForEvent, summarizeResult } from '../lib/agent-runner.mjs';
import { detectPaneHost, reconcileDelegated, delegateToPane } from '../lib/pane-delegation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const STATE_PATH = join(projectRoot, 'state.sqlite');

const POLL_MS = (Number(process.env.POLL_INTERVAL_SEC) || 120) * 1000;
const USERNAME = process.env.GITHUB_USERNAME;
const POST_COMMENTS = process.env.POST_COMMENTS === 'true';

if (!USERNAME) {
  log.error('GITHUB_USERNAME is required (set it in .env or your shell).');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  log.error('ANTHROPIC_API_KEY is required.');
  process.exit(1);
}
if (!logLevelIsKnown) {
  log.error(`unknown LOG_LEVEL "${logLevelName}". Valid: ${Object.keys(LOG_LEVELS).join(', ')}. Falling back to info.`);
}

const gh = makeGh({ ghToken: process.env.GH_TOKEN });
const store = new Store(STATE_PATH);

async function tick() {
  await reconcileDelegated({ store, gh });

  const prs = await listOpenPRs(gh, USERNAME);
  log.info(`scanning ${prs.length} open PR(s) by @${USERNAME}`);

  const events = [];
  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner;
    const detail = await fetchPRDetail(gh, repo, pr.number).catch((err) => {
      log.error(`failed to fetch ${repo}#${pr.number}: ${err.message}`);
      return null;
    });
    if (!detail) continue;
    log.debug(`${repo}#${pr.number}: ${detail.comments.length} issue comments, ${detail.reviewComments.length} review comments`);

    events.push(...buildEventsForPR({ repo, pr, detail, store, username: USERNAME }));
    const mergeEvent = buildMergeEventForPR({ repo, pr, detail });
    if (mergeEvent) events.push(mergeEvent);

    const checks = await fetchChecksForSha(gh, repo, detail.headRefOid);
    events.push(...buildCIEventsForPR({ repo, pr, detail, checks }));
  }

  const fresh = events.filter((e) => !store.isKnown(eventKey(e)));
  sortByPriority(fresh);
  log.info(`${fresh.length} new event(s) to process`);

  for (const event of fresh) {
    const key = eventKey(event);
    log.info(`-> ${event.kind} ${event.repo}#${event.pr}`);

    const wantsGitWork = event.kind === 'branch_behind' || event.kind === 'merge_conflict';
    const flag = event.kind === 'branch_behind' ? 'AUTO_REBASE' : 'RESOLVE_CONFLICTS';
    const flagOn = wantsGitWork && process.env[flag] === 'true';
    const host = wantsGitWork && flagOn ? detectPaneHost() : null;

    if (host) {
      try {
        const { worktreeDir } = await delegateToPane({
          projectRoot, gh, event, host, postComments: POST_COMMENTS,
        });
        log.info(`delegated ${event.kind} ${event.repo}#${event.pr} to ${host} pane (${worktreeDir})`);
        store.markDelegated(key, {
          kind: event.kind, repo: event.repo, pr: event.pr,
          data: {
            host,
            worktreeDir,
            headRefName: event.headRefName,
            headSha: event.headSha,
            baseRefName: event.baseRefName,
            baseSha: event.baseSha,
          },
        });
      } catch (err) {
        log.error(`pane delegation failed for ${event.kind} ${event.repo}#${event.pr}: ${err.message}`);
      }
      continue;
    }

    try {
      const result = await runAgentForEvent(event, { projectRoot, postComments: POST_COMMENTS });
      log.info(summarizeResult(event, result));
      store.markHandled(key, { kind: event.kind, repo: event.repo, pr: event.pr, data: { result } });
    } catch (err) {
      log.error(`agent failed for ${event.kind} ${event.repo}#${event.pr}: ${err.message}`);
    }
  }

  store.setLastScan(new Date().toISOString());
}

async function main() {
  log.info(
    `pr-watcher started. polling every ${POLL_MS / 1000}s. ` +
    `POST_COMMENTS=${POST_COMMENTS} ` +
    `AUTO_REBASE=${process.env.AUTO_REBASE === 'true'} ` +
    `RESOLVE_CONFLICTS=${process.env.RESOLVE_CONFLICTS === 'true'} ` +
    `OPEN_IN_PANE=${process.env.OPEN_IN_PANE ?? 'auto'} (host=${detectPaneHost() ?? 'none'}) ` +
    `LOG_LEVEL=${logLevelName}`
  );

  while (true) {
    const start = Date.now();
    try {
      await tick();
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
