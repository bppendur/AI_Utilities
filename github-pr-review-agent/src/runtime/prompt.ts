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

/**
 * Neutralizes the closing-tag sequence `</` inside PR-derived text before it
 * is interpolated into an XML-style delimiter tag (`<pr_body>`,
 * `<pull_request_diff>`, etc.), so a pull request that embeds e.g.
 * `</pr_body>` in its own text cannot prematurely close the tag and have
 * whatever follows read back as trusted instructions. Inserts a zero-width
 * space between `<` and `/` — invisible to a reader, but breaks the literal
 * sequence a parser (or model) would recognize as a closing tag. The
 * template's own closing tags are written directly in the template text, so
 * they never pass through this function and are never affected.
 */
export function sanitizeUntrusted(value: string): string {
  return value.replace(/<\//g, "<​/");
}

function renderPriorReviews(ctx: PromptContext): string {
  if (ctx.priorReviews.length === 0) {
    return "This is the first review of this pull request. There is no earlier feedback to take into account.";
  }
  const blocks = ctx.priorReviews
    .map(
      (r) =>
        `### Review by ${sanitizeUntrusted(r.author)} (${r.submittedAt})\n\n${sanitizeUntrusted(r.body)}`,
    )
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
    PR_TITLE: sanitizeUntrusted(ctx.pr.title),
    PR_AUTHOR: sanitizeUntrusted(ctx.pr.author),
    BASE_REF: sanitizeUntrusted(ctx.pr.baseRef),
    HEAD_REF: sanitizeUntrusted(ctx.pr.headRef),
    PR_BODY: sanitizeUntrusted(ctx.pr.body.trim()) || "(no description provided)",
    CHANGED_FILES:
      ctx.pr.changedFiles.map((f) => `- ${sanitizeUntrusted(f)}`).join("\n") ||
      "(none reported)",
    DIFF: sanitizeUntrusted(ctx.pr.diff),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}
