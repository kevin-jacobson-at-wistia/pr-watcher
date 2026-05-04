# pr-watcher

A small [Flue](https://flueframework.com/) agent + Node daemon that watches your open GitHub PRs and reacts to:

- **CI failures** — summarizes the failing check and (optionally) drafts a comment with the root cause.
- **Issue comments** on your PRs — drafts a reply when the comment warrants one.
- **PR review comments** (inline) — same triage as above.
- **Branch behind base** (no conflicts) — opt-in: rebases your PR onto the base branch and force-pushes with `--force-with-lease`.
- **Merge conflicts** — opt-in: clones the repo, opens a worktree, attempts to resolve each conflicted file, runs a quick typecheck/test if available, and force-pushes with `--force-with-lease` only when resolution is high-confidence.

Every reply posted on your behalf is prefixed with a collapsed `🤖 Posted by Claude` attribution block so anyone on the thread can immediately tell the comment isn't from you.

## How it works

```
┌─ bin/daemon.mjs (long-running) ─────────────┐
│  every POLL_INTERVAL_SEC (default 120):     │
│   1. gh search prs --author $YOU            │
│   2. for each PR, fetch comments + checks   │
│   3. diff against state.json                │
│   4. for each new event, spawn:             │
│        npx flue run watch --payload …       │
└─────────────────────────────────────────────┘
                  │
                  ▼
┌─ agents/watch.ts (per event) ───────────────┐
│  Flue agent runs `triage-pr-activity` skill │
│  with `gh` available, returns a typed       │
│  result (and optionally posts).             │
└─────────────────────────────────────────────┘
```

The daemon does only cheap GitHub API polling. The LLM is only invoked when there's actually new activity, so quiet days cost ~nothing.

## Setup

Requires Node 22+, `gh` CLI authenticated separately for your shell, and an Anthropic API key.

```bash
git clone <this repo>
cd pr-watcher
npm install
cp .env.example .env
```

Edit `.env`:

| var                 | what                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_USERNAME`   | your GitHub login (the daemon scans PRs authored by this user)                                                                                                                                                                                      |
| `GH_TOKEN`          | optional. PAT with `repo` scope. If unset, falls back to your `gh` keyring auth.                                                                                                                                                                    |
| `ANTHROPIC_API_KEY` | required, for Claude.                                                                                                                                                                                                                               |
| `POLL_INTERVAL_SEC` | seconds between scans (default 120).                                                                                                                                                                                                                |
| `POST_COMMENTS`     | `false` (default) = dry-run, replies are returned in logs only. `true` = actually post via `gh`.                                                                                                                                                    |
| `LOG_LEVEL`         | `silent`, `error`, `info` (default), or `debug`. At `debug`, the spawned `flue run` output is passed through live; at `info`, only a one-line per-event summary is shown.                                                                           |
| `AUTO_REBASE`       | `false` (default) or `true`. When `true` and a PR is BEHIND its base with no conflicts, the agent rebases and force-pushes with `--force-with-lease`.                                                                                               |
| `RESOLVE_CONFLICTS` | `false` (default) or `true`. When `true` and a PR is DIRTY, the agent attempts to resolve each conflicted file, runs a quick typecheck if available, and force-pushes only on high-confidence resolution. Bails (no push) when intent is ambiguous. |

Then:

```bash
npm start
```

Leave it running in a terminal. First scan happens immediately, then every `POLL_INTERVAL_SEC`.

## Dry-run first

Start with `POST_COMMENTS=false` (the default). The daemon will log the drafted replies for each event so you can audit the agent's judgment. Once you trust it, flip `POST_COMMENTS=true` and restart.

## State

The daemon writes `state.json` next to itself with the IDs of every comment/check it has already processed. Delete the file to re-process everything from scratch.

## Rebase / conflict resolution layout

When `AUTO_REBASE` or `RESOLVE_CONFLICTS` is enabled, the agent uses git worktrees off a persistent local clone instead of cloning per event:

```
git/
└── <owner>__<name>/
    ├── main/                          # persistent clone (--filter=blob:none)
    └── wt-pr-<num>-<shortsha>/        # ephemeral worktree, removed after each attempt
```

The `git/` dir is gitignored. Persistent clones survive across runs so subsequent rebases on the same repo are fast (just `git fetch`). Worktrees are torn down on every attempt — even on failure — so a stuck rebase never blocks the next one.

Force-pushes always use `--force-with-lease=<headRef>:<expected-sha>`, so a push fails fast if you've pushed new commits to that branch since the agent started its rebase.

Requires `gh auth setup-git` to be configured so `git` over HTTPS uses your gh credentials.

To change behavior:

- `.agents/skills/resolve-pr-conflicts/SKILL.md` — the rebase/resolve workflow.
- `agents/watch.ts` — gating (the `AUTO_REBASE` / `RESOLVE_CONFLICTS` checks live here, not in the skill).

## Customizing

Anyone can clone this repo, set their own `GITHUB_USERNAME`, and they're off — nothing in the agent's prompt or skill is hardcoded to a specific operator.

To change behavior:

- `AGENTS.md` — top-level system prompt: scope, attribution rule, posting policy, tone.
- `.agents/skills/triage-pr-activity/SKILL.md` — the per-event triage workflow (runtime-loaded; dot prefix is required by Flue's sandbox).
- `roles/pr-assistant.md` — assistant persona applied to each call.
- `agents/watch.ts` — wiring (model, sandbox, schema). Change the model id here.

## Running just one event manually

Useful for debugging a specific PR without waiting for the daemon:

```bash
npx flue run watch --target node --id manual-test \
  --payload '{
    "kind": "ci_failure",
    "repo": "owner/repo",
    "pr": 123,
    "checkRunId": 456789,
    "checkName": "build / lint",
    "headSha": "abc123"
  }'
```
