# pr-watcher

A small [Flue](https://flueframework.com/) agent + Node daemon that watches your open GitHub PRs and reacts to:

- **CI failures** — summarizes the failing check and (optionally) drafts a comment with the root cause.
- **Issue comments** on your PRs — drafts a reply when the comment warrants one.
- **PR review comments** (inline) — same triage as above.

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

| var                 | what                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `GITHUB_USERNAME`   | your GitHub login (the daemon scans PRs authored by this user)                                   |
| `GH_TOKEN`          | optional. PAT with `repo` scope. If unset, falls back to your `gh` keyring auth.                 |
| `ANTHROPIC_API_KEY` | required, for Claude.                                                                            |
| `POLL_INTERVAL_SEC` | seconds between scans (default 120).                                                             |
| `POST_COMMENTS`     | `false` (default) = dry-run, replies are returned in logs only. `true` = actually post via `gh`. |

Then:

```bash
npm start
```

Leave it running in a terminal. First scan happens immediately, then every `POLL_INTERVAL_SEC`.

## Dry-run first

Start with `POST_COMMENTS=false` (the default). The daemon will log the drafted replies for each event so you can audit the agent's judgment. Once you trust it, flip `POST_COMMENTS=true` and restart.

## State

The daemon writes `state.json` next to itself with the IDs of every comment/check it has already processed. Delete the file to re-process everything from scratch.

## Customizing

Anyone can clone this repo, set their own `GITHUB_USERNAME`, and they're off — nothing in the agent's prompt or skill is hardcoded to a specific operator.

To change behavior:

- `AGENTS.md` — top-level system prompt: scope, attribution rule, posting policy, tone.
- `agents/skills/triage-pr-activity/SKILL.md` — the per-event triage workflow.
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
