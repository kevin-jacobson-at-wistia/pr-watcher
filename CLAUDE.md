# pr-watcher — agent guide

This file is for Claude Code (or any agent) editing **this repo**. The runtime
system prompt for the Flue agent that pr-watcher *spawns* lives in
`AGENTS.md` — don't confuse the two.

## What this is

A long-running Node daemon that polls external systems (GitHub today,
Shortcut planned) and reacts to events by either:

1. Running a Flue agent in-process (cheap, sandboxed via `@flue/sdk`), or
2. Setting up a git worktree and delegating to a fresh `claude
   --dangerously-skip-permissions` pane (tmux split / iTerm tab) for
   higher-stakes git work.

`README.md` has the user-facing walkthrough — read that for env vars and
behavior. This file is for working on the code.

## Layout

| Path                        | Purpose                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/daemon.mjs`            | Long-running loop. Polls, builds events, dispatches.                                                                                   |
| `lib/*.mjs`                 | Daemon-side helpers (state store, GitHub event builders, pane delegation, etc.). All ESM `.mjs` — no TypeScript on the daemon side.    |
| `agents/watch.ts`           | The Flue agent entry point. Picks a skill based on the event kind. Schemas defined here with valibot.                                  |
| `.agents/skills/<name>/`    | Skill content loaded by Flue at runtime. Dot-prefixed dir is required by Flue's sandbox — keep the dot.                                |
| `roles/pr-assistant.md`     | Persona prepended to each Flue session.                                                                                                |
| `state.sqlite`              | Event ledger (handled / delegated). Schema in `lib/state.mjs`.                                                                         |
| `git/<owner>__<name>/main/` | Persistent clones. Auto-discovered if a sibling clone of the target repo already exists nearby (see `findExistingClone`).              |
| `git/<owner>__<name>/wt-*/` | Ephemeral worktrees, torn down each attempt. Always operate **detached** — branches may be checked out elsewhere.                      |

## Conventions

- **`.mjs` on the daemon side, `.ts` only for `agents/watch.ts`.** The Flue
  CLI is what compiles `agents/*.ts`; nothing else uses TS here. Don't
  convert `lib/*.mjs` to TS without rewiring `package.json`.
- **No build step for the daemon.** `npm start` runs node against `.mjs`
  directly. Imports must use the `.mjs` extension.
- **Logging**: use `lib/log.mjs`. Levels: `silent`, `error`, `info`,
  `debug`. Default `info` should print one line per event; verbose detail
  goes to `debug`.
- **State**: every event has a stable `eventKey()` (in `lib/state.mjs`).
  Don't process the same key twice. New event kinds need a case in
  `eventKey()` AND a row in the `PRIORITY` map.
- **Delegated events** (long-running pane work) are reconciled each tick by
  `reconcileDelegated()` — they get cleared when the remote moves OR when
  the claude process dies and the worktree is gone.
- **Detached HEAD always** in spawned worktrees. The user's main checkout
  may have any of these branches checked out; `git switch` would clobber
  it. The rebase prompt enforces this — keep enforcing it in any new
  prompts.

## Adding a new event kind

The pattern is consistent — copy it:

1. **Detect**: add a builder in `lib/<source>-events.mjs` that returns
   plain `{ kind, ... }` objects. Pull data only; no side effects.
2. **Route**: in `bin/daemon.mjs`'s `tick()`, call your builder, push
   results into the events array, filter against `store.isKnown()`.
3. **Identify**: extend `eventKey()` and `PRIORITY` in `lib/state.mjs`.
4. **Handle**: either
   - **In-process**: add a branch in `agents/watch.ts` (extend
     `EventSchema`, return a result schema), and the runner in
     `lib/agent-runner.mjs` will pick it up automatically.
   - **In a pane**: extend `lib/pane-delegation.mjs` to know how to set up
     the worktree and what prompt to spawn, then dispatch from
     `bin/daemon.mjs` with `delegateToPane()`.
5. **Document**: README.md gets the env vars; this file gets the routing
   note if the pattern is unusual.

Gating new behavior behind an env var that defaults to off is the house
style — see `AUTO_REBASE`, `RESOLVE_CONFLICTS`, `REBASE_ON_CI_NOISE`,
`POST_COMMENTS`.

## Running locally

```bash
npm start                                    # full daemon loop
node --experimental-sqlite bin/daemon.mjs    # same, no .env autoload
```

To exercise one event without polling, see the "Running just one event
manually" section of `README.md` (uses `npx flue run watch --payload '…'`).

## Things to avoid

- **Don't** add `--no-verify` / `--force` (without `--force-with-lease`) /
  destructive git ops in spawned prompts. The rebase prompt is careful
  about this; new prompts should be too.
- **Don't** ship code paths that post GitHub comments without going
  through the `POST_COMMENTS` gate and the `🤖 Posted by Claude`
  attribution block from `AGENTS.md`.
- **Don't** auto-resolve ambiguous conflicts. Skills bail and stop instead
  of guessing. New skills should follow that.
- **Don't** introduce TypeScript on the daemon side or move skills out of
  `.agents/skills/`. Both will silently break Flue.
