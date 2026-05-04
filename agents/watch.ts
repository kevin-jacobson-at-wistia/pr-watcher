import { type FlueContext } from "@flue/sdk/client";
import { defineCommand } from "@flue/sdk/node";
import * as v from "valibot";

export const triggers = {};

const gh = defineCommand("gh", {
  env: process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {},
});
const git = defineCommand("git");

const TriageEventSchema = v.union([
  v.object({
    kind: v.literal("ci_failure"),
    repo: v.string(),
    pr: v.number(),
    checkRunId: v.number(),
    checkName: v.string(),
    headSha: v.string(),
  }),
  v.object({
    kind: v.literal("issue_comment"),
    repo: v.string(),
    pr: v.number(),
    commentId: v.number(),
    author: v.string(),
    body: v.string(),
  }),
  v.object({
    kind: v.literal("review_comment"),
    repo: v.string(),
    pr: v.number(),
    commentId: v.number(),
    author: v.string(),
    body: v.string(),
    path: v.string(),
    line: v.number(),
  }),
]);

const RebaseEventSchema = v.object({
  kind: v.literal("branch_behind"),
  repo: v.string(),
  pr: v.number(),
  headRefName: v.string(),
  headSha: v.string(),
  baseRefName: v.string(),
  baseSha: v.string(),
});

const ConflictEventSchema = v.object({
  kind: v.literal("merge_conflict"),
  repo: v.string(),
  pr: v.number(),
  headRefName: v.string(),
  headSha: v.string(),
  baseRefName: v.string(),
  baseSha: v.string(),
});

const EventSchema = v.union([
  TriageEventSchema,
  RebaseEventSchema,
  ConflictEventSchema,
]);

const TriageResultSchema = v.object({
  skipped: v.boolean(),
  reason: v.string(),
  draft: v.nullable(v.string()),
  posted: v.boolean(),
  ciSummary: v.nullable(v.string()),
  relatedToChanges: v.optional(v.nullable(v.boolean()), null),
});

const ResolveResultSchema = v.object({
  skipped: v.boolean(),
  reason: v.string(),
  outcome: v.picklist([
    "rebased-and-pushed",
    "conflicts-resolved-and-pushed",
    "rebased-locally-not-pushed",
    "drafted-resolution-not-pushed",
    "could-not-resolve",
    "no-op",
  ]),
  pushedSha: v.nullable(v.string()),
  conflictedFiles: v.array(v.string()),
  draft: v.nullable(v.string()),
  posted: v.boolean(),
});

export default async function ({ init, payload }: FlueContext) {
  const event = v.parse(EventSchema, payload);

  const agent = await init({
    sandbox: "local",
    model: "anthropic/claude-sonnet-4-6",
  });
  const session = await agent.session();

  if (event.kind === "branch_behind" || event.kind === "merge_conflict") {
    const flag =
      event.kind === "branch_behind" ? "AUTO_REBASE" : "RESOLVE_CONFLICTS";
    if (process.env[flag] !== "true") {
      return {
        skipped: true,
        reason: `${event.kind} detected on ${event.repo}#${event.pr} but ${flag} is not enabled`,
        outcome: "no-op",
        pushedSha: null,
        conflictedFiles: [],
        draft: null,
        posted: false,
      };
    }
    const slug = event.repo.replace("/", "__");
    const projectRoot = process.cwd();
    const cloneDir = `${projectRoot}/git/${slug}/main`;
    const shortSha = event.headSha.slice(0, 8);
    const worktreeDir = `${projectRoot}/git/${slug}/wt-pr-${event.pr}-${shortSha}`;
    return await session.skill("resolve-pr-conflicts", {
      args: {
        ...event,
        mode:
          event.kind === "branch_behind" ? "rebase-only" : "resolve-conflicts",
        projectRoot,
        cloneDir,
        worktreeDir,
        slug,
      },
      role: "pr-assistant",
      commands: [gh, git],
      result: ResolveResultSchema,
    });
  }

  return await session.skill("triage-pr-activity", {
    args: event,
    role: "pr-assistant",
    commands: [gh],
    result: TriageResultSchema,
  });
}
