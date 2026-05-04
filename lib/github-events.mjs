export async function listOpenPRs(gh, username) {
  return gh([
    'search', 'prs',
    '--author', username,
    '--state', 'open',
    '--limit', '50',
    '--json', 'repository,number,title,updatedAt',
  ]);
}

export async function fetchPRDetail(gh, repo, pr) {
  const [meta, comments, reviewComments] = await Promise.all([
    gh(['pr', 'view', String(pr), '--repo', repo, '--json',
        'headRefOid,headRefName,baseRefName,baseRefOid,mergeable,mergeStateStatus']),
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

export async function fetchChecksForSha(gh, repo, sha) {
  const data = await gh([
    'api', `repos/${repo}/commits/${sha}/check-runs`,
    '-H', 'Accept: application/vnd.github+json',
  ]).catch(() => ({ check_runs: [] }));
  return data.check_runs ?? [];
}

export function buildEventsForPR({ repo, pr, detail, store, username }) {
  const events = [];

  for (const c of detail.comments) {
    const ev = {
      kind: 'issue_comment', repo, pr: pr.number,
      commentId: c.id,
      author: c.user?.login ?? 'unknown',
      body: c.body ?? '',
    };
    if (c.user?.login === username) continue;
    events.push(ev);
  }

  for (const c of detail.reviewComments) {
    if (c.user?.login === username) continue;
    events.push({
      kind: 'review_comment', repo, pr: pr.number,
      commentId: c.id,
      author: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      path: c.path ?? '',
      line: c.line ?? c.original_line ?? 0,
    });
  }

  return events;
}

export function buildMergeEventForPR({ repo, pr, detail }) {
  if (detail.mergeStateStatus === 'BEHIND') {
    return {
      kind: 'branch_behind',
      repo, pr: pr.number,
      headRefName: detail.headRefName,
      headSha: detail.headRefOid,
      baseRefName: detail.baseRefName,
      baseSha: detail.baseRefOid,
    };
  }
  if (detail.mergeStateStatus === 'DIRTY') {
    return {
      kind: 'merge_conflict',
      repo, pr: pr.number,
      headRefName: detail.headRefName,
      headSha: detail.headRefOid,
      baseRefName: detail.baseRefName,
      baseSha: detail.baseRefOid,
    };
  }
  return null;
}

export function buildCIEventsForPR({ repo, pr, detail, checks }) {
  return checks
    .filter((cr) => cr.conclusion === 'failure')
    .map((cr) => ({
      kind: 'ci_failure',
      repo, pr: pr.number,
      checkRunId: cr.id,
      checkName: cr.name,
      headSha: detail.headRefOid,
    }));
}
