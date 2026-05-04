import { DatabaseSync } from 'node:sqlite';

export class Store {
  #db;
  #stmts;

  constructor(path) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr INTEGER,
        status TEXT NOT NULL CHECK(status IN ('handled', 'delegated')),
        data TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_status_idx ON events(status);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.#stmts = {
      get: this.#db.prepare('SELECT * FROM events WHERE key = ?'),
      put: this.#db.prepare(`
        INSERT INTO events (key, kind, repo, pr, status, data, at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET status=excluded.status, data=excluded.data, at=excluded.at
      `),
      del: this.#db.prepare('DELETE FROM events WHERE key = ?'),
      listByStatus: this.#db.prepare('SELECT * FROM events WHERE status = ?'),
      metaGet: this.#db.prepare('SELECT value FROM meta WHERE key = ?'),
      metaPut: this.#db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `),
    };
  }

  isHandled(key) {
    const row = this.#stmts.get.get(key);
    return row?.status === 'handled';
  }

  isDelegated(key) {
    const row = this.#stmts.get.get(key);
    return row?.status === 'delegated';
  }

  isKnown(key) {
    return !!this.#stmts.get.get(key);
  }

  markHandled(key, { kind, repo, pr, data }) {
    this.#stmts.put.run(key, kind, repo, pr ?? null, 'handled', JSON.stringify(data ?? {}), Date.now());
  }

  markDelegated(key, { kind, repo, pr, data }) {
    this.#stmts.put.run(key, kind, repo, pr ?? null, 'delegated', JSON.stringify(data ?? {}), Date.now());
  }

  remove(key) {
    this.#stmts.del.run(key);
  }

  listDelegated() {
    return this.#stmts.listByStatus.all('delegated').map((row) => ({
      key: row.key,
      kind: row.kind,
      repo: row.repo,
      pr: row.pr,
      at: row.at,
      data: JSON.parse(row.data),
    }));
  }

  setLastScan(iso) {
    this.#stmts.metaPut.run('lastScan', iso);
  }

  getLastScan() {
    return this.#stmts.metaGet.get('lastScan')?.value ?? null;
  }

  close() {
    this.#db.close();
  }
}

const PRIORITY = {
  merge_conflict: 0,
  branch_behind: 1,
  ci_failure: 2,
  issue_comment: 3,
  review_comment: 4,
  shortcut_story: 5,
};

export function sortByPriority(events) {
  return events.sort((a, b) => (PRIORITY[a.kind] ?? 99) - (PRIORITY[b.kind] ?? 99));
}

export function eventKey(event) {
  switch (event.kind) {
    case 'issue_comment':
    case 'review_comment':
      return `${event.kind}:${event.repo}:${event.commentId}`;
    case 'ci_failure':
      return `${event.kind}:${event.repo}:${event.checkRunId}`;
    case 'branch_behind':
    case 'merge_conflict':
      return `${event.kind}:${event.repo}:${event.pr}:${event.headSha}:${event.baseSha}`;
    case 'shortcut_story':
      return `${event.kind}:${event.storyId}`;
    default:
      return `${event.kind}:${event.repo}:${event.pr}`;
  }
}
