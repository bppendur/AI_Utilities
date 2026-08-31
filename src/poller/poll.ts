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
    // PRs actually reviewed by the auto pass THIS cycle. Local to one pollOnce
    // call — never persisted. Lets the manual pass below recognize a PR the
    // auto pass just handled, instead of posting a second review for it.
    const reviewedThisCycle = new Set<string>();

    // Pass 1 — automatic discovery, gated by the repo's raw filter string.
    try {
      const numbers = await deps.github.searchPullRequestNumbers(buildAutoQuery(repo));
      for (const prNumber of numbers) {
        const key = prKey(repo.fullName, prNumber);
        // Inside the per-PR try: a throw here (e.g. a corrupt state read) is
        // one PR's failure, not the whole repo's — the remaining PRs in this
        // list must still get a chance.
        try {
          if (deps.state.hasBeenReviewed(key)) {
            summary.skipped += 1;
            continue;
          }
          const outcome = await deps.runReview({ repo, prNumber, trigger: "auto", deps });
          if (outcome.reviewed) {
            summary.autoReviewed += 1;
            reviewedThisCycle.add(key);
          } else {
            summary.skipped += 1;
          }
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

          if (reviewedThisCycle.has(key)) {
            // The auto pass already reviewed this PR earlier in this same
            // cycle — the trigger comment's request has been satisfied by
            // that review. Advance the marker so it isn't re-fired next
            // cycle, but don't post a second review for it.
            await deps.state.setLastTriggerCommentId(key, newest);
            continue;
          }

          // Persist the trigger id BEFORE reviewing, not after. A review is
          // a real, possibly-paid, externally-visible action (a clone plus
          // a review posted to GitHub) that cannot be undone once it
          // succeeds, so we must never risk repeating it. Marking the
          // trigger processed first guarantees each trigger comment causes
          // at most ONE review attempt, ever — ordering, not a retry count,
          // is what makes that guarantee hold:
          //   - if this write throws, nothing has been posted yet, so the
          //     catch below logs it and the next cycle retries cleanly;
          //   - if it succeeds and runReview then fails, that specific
          //     request is deliberately NOT retried automatically — the
          //     recovery path is the human commenting the trigger phrase
          //     again, not the poller looping forever (unbounded clones and
          //     paid model calls) on a possibly permanently-broken PR.
          // Do not move this write back after runReview.
          await deps.state.setLastTriggerCommentId(key, newest);
          await deps.runReview({ repo, prNumber, trigger: "manual", deps });
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
