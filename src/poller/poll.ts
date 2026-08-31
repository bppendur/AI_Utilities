import type { ResolvedRepo } from "../config/schema.js";
import { buildAutoQuery, buildTriggerQuery } from "../github/queries.js";
import type { ReviewDeps, runReview as RunReviewFn } from "../review/run-review.js";
import { prKey } from "../state/store.js";

export interface PollDeps extends ReviewDeps {
  triggerPhrase: string;
  runReview: typeof RunReviewFn;
}

export interface PollSummary {
  autoReviewed: number;
  manualReviewed: number;
  skipped: number;
  errors: number;
}

export async function pollOnce(
  repos: ResolvedRepo[],
  deps: PollDeps,
): Promise<PollSummary> {
  const summary: PollSummary = { autoReviewed: 0, manualReviewed: 0, skipped: 0, errors: 0 };

  for (const repo of repos) {
    // Pass 1 — automatic discovery, gated by the repo's raw filter string.
    try {
      const numbers = await deps.github.searchPullRequestNumbers(buildAutoQuery(repo));
      for (const prNumber of numbers) {
        const key = prKey(repo.fullName, prNumber);
        if (deps.state.hasBeenReviewed(key)) {
          summary.skipped += 1;
          continue;
        }
        try {
          const outcome = await deps.runReview({ repo, prNumber, trigger: "auto", deps });
          if (outcome.reviewed) summary.autoReviewed += 1;
          else summary.skipped += 1;
        } catch (error) {
          summary.errors += 1;
          deps.logger.error(`Auto review failed for ${key}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      summary.errors += 1;
      deps.logger.error(`Auto discovery failed for ${repo.fullName}: ${(error as Error).message}`);
    }

    // Pass 2 — manual triggers. Deliberately ignores the filter.
    try {
      const numbers = await deps.github.searchPullRequestNumbers(
        buildTriggerQuery(repo, deps.triggerPhrase),
      );
      for (const prNumber of numbers) {
        const key = prKey(repo.fullName, prNumber);
        try {
          const comments = await deps.github.listTriggerComments(
            { owner: repo.owner, repo: repo.name, number: prNumber },
            deps.triggerPhrase,
          );
          const seen = deps.state.lastTriggerCommentId(key);
          const newest = comments.reduce((max, c) => Math.max(max, c.id), 0);
          if (newest <= seen) continue;
          await deps.runReview({ repo, prNumber, trigger: "manual", deps });
          await deps.state.setLastTriggerCommentId(key, newest);
          summary.manualReviewed += 1;
        } catch (error) {
          summary.errors += 1;
          deps.logger.error(`Manual review failed for ${key}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      summary.errors += 1;
      deps.logger.error(
        `Trigger discovery failed for ${repo.fullName}: ${(error as Error).message}`,
      );
    }
  }

  return summary;
}
