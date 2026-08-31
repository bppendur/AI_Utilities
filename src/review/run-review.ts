import type { ResolvedRepo } from "../config/schema.js";
import type { GitHubClient } from "../github/client.js";
import type { postReview as PostReviewFn } from "../github/post-review.js";
import type { Logger } from "../logger.js";
import { buildPrompt } from "../runtime/prompt.js";
import type { ReviewRuntime } from "../runtime/types.js";
import { prKey, type StateStore } from "../state/store.js";
import type { createWorkspace as CreateWorkspaceFn } from "../workspace/checkout.js";

export interface ReviewDeps {
  github: GitHubClient;
  runtime: ReviewRuntime;
  state: StateStore;
  logger: Logger;
  template: string;
  token: string;
  workspaceRoot: string;
  timeoutMs: number;
  createWorkspace: typeof CreateWorkspaceFn;
  postReview: typeof PostReviewFn;
}

export interface RunReviewOptions {
  repo: ResolvedRepo;
  prNumber: number;
  trigger: "auto" | "manual";
  deps: ReviewDeps;
}

export interface RunReviewOutcome {
  reviewed: boolean;
  passNumber: number;
  findingCount: number;
  inline: boolean;
  skippedReason?: string;
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewOutcome> {
  const { repo, prNumber, trigger, deps } = options;
  const ref = { owner: repo.owner, repo: repo.name, number: prNumber };
  const key = prKey(repo.fullName, prNumber);

  const pr = await deps.github.getPullRequest(ref);

  // A draft is not ready for automatic review, but an explicit request wins.
  if (pr.draft && trigger === "auto") {
    deps.logger.info(`Skipping draft PR ${key}`);
    return { reviewed: false, passNumber: 0, findingCount: 0, inline: false, skippedReason: "draft" };
  }

  const priorReviews = await deps.github.listPriorReviews(ref);
  const passNumber = deps.state.passCount(key) + 1;

  const workspace = await deps.createWorkspace({
    owner: repo.owner,
    name: repo.name,
    prNumber,
    baseRef: pr.baseRef,
    token: deps.token,
    rootDir: deps.workspaceRoot,
  });

  try {
    const prompt = buildPrompt(deps.template, {
      role: repo.role,
      repoFullName: repo.fullName,
      passNumber,
      pr,
      priorReviews,
    });
    deps.logger.info(`Reviewing ${key} (pass ${passNumber}, trigger ${trigger})`);
    const result = await deps.runtime.review({
      prompt,
      workspaceDir: workspace.dir,
      timeoutMs: deps.timeoutMs,
    });
    const { inline } = await deps.postReview(deps.github.octokit, ref, pr.headSha, result);
    // Recorded only after a successful post, so a failed post is retried.
    await deps.state.recordPass(key);
    deps.logger.info(
      `Posted review for ${key}: ${result.findings.length} findings (inline=${inline})`,
    );
    return { reviewed: true, passNumber, findingCount: result.findings.length, inline };
  } finally {
    await workspace.cleanup();
  }
}
