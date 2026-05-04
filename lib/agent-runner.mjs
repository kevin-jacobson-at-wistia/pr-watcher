import { spawn } from 'node:child_process';
import { passthroughChild } from './log.mjs';

export function runAgentForEvent(event, { projectRoot, postComments, extraEnv = {} }) {
  return new Promise((resolve, reject) => {
    const id = `pr-watcher-${event.kind}-${event.repo.replace('/', '_')}-${event.pr}`;
    const child = spawn(
      'npx',
      ['flue', 'run', 'watch', '--target', 'node', '--id', id, '--payload', JSON.stringify(event)],
      {
        cwd: projectRoot,
        env: { ...process.env, POST_COMMENTS: postComments ? 'true' : 'false', ...extraEnv },
        stdio: ['ignore', 'pipe', passthroughChild ? 'inherit' : 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      if (passthroughChild) process.stdout.write(d);
      stdout += d;
    });
    if (!passthroughChild && child.stderr) {
      child.stderr.on('data', (d) => (stderr += d));
    }
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = passthroughChild ? '' : `\n--- flue stderr ---\n${stderr}`;
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

export function summarizeResult(event, result) {
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
