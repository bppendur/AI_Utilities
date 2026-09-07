import type { Octokit } from "@octokit/rest";
import type { PullRequestRef } from "./client.js";
import { defaultSecrets, redact } from "../logger.js";
import type { ReviewResult } from "../runtime/types.js";

function findingBody(severity: string, body: string): string {
  return `**${severity.toUpperCase()}** — ${body}`;
}

function summaryWithFindings(result: ReviewResult): string {
  if (result.findings.length === 0) return result.summary;
  const lines = result.findings.map(
    (f) => `- \`${f.file}:${f.line}\` **${f.severity.toUpperCase()}** — ${f.body}`,
  );
  return `${result.summary}\n\n<details><summary>Findings</summary>\n\n${lines.join("\n")}\n\n</details>`;
}

/**
 * Redacts known secret values (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) out of
 * the model's own output before it is posted. The reviewed content the
 * model reads (PR title/body/diff) is attacker-controlled, so a
 * sufficiently crafted prompt injection could try to make the model echo a
 * secret value back into its `summary` or a finding's `body` — which this
 * service would otherwise post verbatim to a public PR comment. Reuses the
 * same secret list `createLogger` redacts from log lines, rather than
 * hardcoding, so both stay in sync.
 */
function sanitizeReviewResult(result: ReviewResult): ReviewResult {
  const secrets = defaultSecrets();
  return {
    summary: redact(result.summary, secrets),
    findings: result.findings.map((f) => ({ ...f, body: redact(f.body, secrets) })),
  };
}

/**
 * Posts the review. Always `event: "COMMENT"` — this service never approves
 * a PR nor requests changes. If GitHub rejects the inline positions (422,
 * typically a line outside the diff), retries once as a summary-only review
 * so the findings are never lost.
 */
export async function postReview(
  octokit: Octokit,
  ref: PullRequestRef,
  headSha: string,
  rawResult: ReviewResult,
): Promise<{ inline: boolean }> {
  const result = sanitizeReviewResult(rawResult);
  const base = {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    commit_id: headSha,
    event: "COMMENT" as const,
  };

  if (result.findings.length === 0) {
    await octokit.rest.pulls.createReview({ ...base, body: result.summary });
    return { inline: false };
  }

  try {
    await octokit.rest.pulls.createReview({
      ...base,
      body: result.summary,
      comments: result.findings.map((f) => ({
        path: f.file,
        line: f.line,
        side: "RIGHT" as const,
        body: findingBody(f.severity, f.body),
      })),
    });
    return { inline: true };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 422) throw error;
    await octokit.rest.pulls.createReview({ ...base, body: summaryWithFindings(result) });
    return { inline: false };
  }
}
