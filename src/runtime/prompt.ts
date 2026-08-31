import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PriorReview, PullRequestDetails } from "../github/client.js";

const here = dirname(fileURLToPath(import.meta.url));

/** `src/runtime/` in dev, `dist/runtime/` after build — `agent/` sits beside both. */
export const DEFAULT_TEMPLATE_PATH = join(here, "..", "..", "agent", "pr-review-agent.md");

export interface PromptContext {
  role: string;
  repoFullName: string;
  passNumber: number;
  pr: PullRequestDetails;
  priorReviews: PriorReview[];
}

export async function loadTemplate(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function renderPriorReviews(ctx: PromptContext): string {
  if (ctx.priorReviews.length === 0) {
    return "This is the first review of this pull request. There is no earlier feedback to take into account.";
  }
  const blocks = ctx.priorReviews
    .map((r) => `### Review by ${r.author} (${r.submittedAt})\n\n${r.body}`)
    .join("\n\n");
  return [
    "Earlier reviews of this pull request are shown below. Check which points have",
    "already been resolved by the current code, say so explicitly in your summary,",
    "and do not repeat findings that no longer apply.",
    "",
    blocks,
  ].join("\n");
}

export function buildPrompt(template: string, ctx: PromptContext): string {
  const values: Record<string, string> = {
    ROLE: ctx.role.trim(),
    PASS_NUMBER: String(ctx.passNumber),
    PRIOR_REVIEWS: renderPriorReviews(ctx),
    REPO: ctx.repoFullName,
    PR_NUMBER: String(ctx.pr.number),
    PR_TITLE: ctx.pr.title,
    PR_AUTHOR: ctx.pr.author,
    BASE_REF: ctx.pr.baseRef,
    HEAD_REF: ctx.pr.headRef,
    PR_BODY: ctx.pr.body.trim() || "(no description provided)",
    CHANGED_FILES: ctx.pr.changedFiles.map((f) => `- ${f}`).join("\n") || "(none reported)",
    DIFF: ctx.pr.diff,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}
