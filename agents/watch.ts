import { type FlueContext } from "@flue/sdk/client";
import { defineCommand } from "@flue/sdk/node";
import * as v from "valibot";

export const triggers = {};

const gh = defineCommand("gh", {
  env: process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {},
});

const EventSchema = v.union([
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

const ResultSchema = v.object({
  skipped: v.boolean(),
  reason: v.string(),
  draft: v.nullable(v.string()),
  posted: v.boolean(),
  ciSummary: v.nullable(v.string()),
});

export default async function ({ init, payload }: FlueContext) {
  const event = v.parse(EventSchema, payload);

  const agent = await init({
    sandbox: "local",
    model: "anthropic/claude-sonnet-4-6",
  });
  const session = await agent.session();

  return await session.skill("triage-pr-activity", {
    args: event,
    role: "pr-assistant",
    commands: [gh],
    result: ResultSchema,
  });
}
