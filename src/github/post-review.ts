import type { Octokit } from "@octokit/rest";
import type { PullRequestRef } from "./client.js";
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
 * Posts the review. Always `event: "COMMENT"` — this service never approves
 * a PR nor requests changes. If GitHub rejects the inline positions (422,
 * typically a line outside the diff), retries once as a summary-only review
 * so the findings are never lost.
 */
export async function postReview(
  octokit: Octokit,
  ref: PullRequestRef,
  headSha: string,
  result: ReviewResult,
): Promise<{ inline: boolean }> {
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
