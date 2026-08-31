import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRepo } from "../../src/config/schema.js";
import { MAX_CONSECUTIVE_AUTO_FAILURES, pollOnce } from "../../src/poller/poll.js";
import { StateStore } from "../../src/state/store.js";

const repo: ResolvedRepo = {
  owner: "acme", name: "api", fullName: "acme/api",
  role: "r", filter: "draft:false",
};

let dir: string;

async function makeDeps(over: Record<string, unknown> = {}) {
  return {
    github: {
      searchPullRequestNumbers: vi.fn().mockResolvedValue([]),
      listTriggerComments: vi.fn().mockResolvedValue([]),
      octokit: {} as never,
    },
    state: await StateStore.open(join(dir, "state.json")),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    triggerPhrase: "@review-agent review",
    runReview: vi.fn().mockResolvedValue({
      reviewed: true, passNumber: 1, findingCount: 0, inline: true,
    }),
    ...over,
  } as never;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prpoll-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pollOnce", () => {
  it("reviews newly discovered PRs and skips ones already reviewed", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [] : [10, 11]),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
    });
    await deps.state.recordPass("acme/api#11");

    const summary = await pollOnce([repo], deps);
    expect(summary.autoReviewed).toBe(1);
    expect(deps.runReview).toHaveBeenCalledOnce();
    expect((deps.runReview as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      prNumber: 10, trigger: "auto",
    });
  });

  it("uses the auto query for discovery and the trigger query for comments", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const deps = await makeDeps({
      github: { searchPullRequestNumbers: search, listTriggerComments: vi.fn(), octokit: {} as never },
    });
    await pollOnce([repo], deps);
    const queries = search.mock.calls.map((c) => c[0]);
    expect(queries[0]).toBe("repo:acme/api is:pr is:open draft:false");
    expect(queries[1]).toBe('repo:acme/api is:pr is:open "@review-agent review" in:comments');
  });

  it("runs a manual pass for an unprocessed trigger comment and remembers its id", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [20] : []),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([
          { id: 900, author: "bhanu", createdAt: "2026-01-01", body: "@review-agent review" },
        ]),
        octokit: {} as never,
      },
    });
    const summary = await pollOnce([repo], deps);
    expect(summary.manualReviewed).toBe(1);
    expect((deps.runReview as ReturnType<typeof vi.fn>).mock.calls[0]![0].trigger).toBe("manual");
    expect(deps.state.lastTriggerCommentId("acme/api#20")).toBe(900);
  });

  it("does not re-fire on a trigger comment it has already processed", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [20] : []),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([
          { id: 900, author: "bhanu", createdAt: "2026-01-01", body: "@review-agent review" },
        ]),
        octokit: {} as never,
      },
    });
    await deps.state.setLastTriggerCommentId("acme/api#20", 900);
    const summary = await pollOnce([repo], deps);
    expect(summary.manualReviewed).toBe(0);
    expect(deps.runReview).not.toHaveBeenCalled();
  });

  it("keeps polling the remaining repos when one PR review throws", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [] : [10, 11]),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
      runReview: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ reviewed: true, passNumber: 1, findingCount: 0, inline: true }),
    });
    const summary = await pollOnce([repo], deps);
    expect(summary.errors).toBe(1);
    expect(summary.autoReviewed).toBe(1);
  });

  it("keeps reviewing remaining PRs in a repo when checking review state throws for one of them", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [] : [10, 11]),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
    });
    vi.spyOn(deps.state, "hasBeenReviewed").mockImplementationOnce(() => {
      throw new Error("state corrupt");
    });

    const summary = await pollOnce([repo], deps);
    expect(summary.errors).toBe(1);
    expect(summary.autoReviewed).toBe(1);
  });

  it("fully processes the remaining repos when an earlier repo's discovery search rejects", async () => {
    const repoA: ResolvedRepo = {
      owner: "acme", name: "svc-a", fullName: "acme/svc-a", role: "r", filter: "",
    };
    const repoB: ResolvedRepo = {
      owner: "acme", name: "svc-b", fullName: "acme/svc-b", role: "r", filter: "",
    };
    const runReview = vi.fn().mockResolvedValue({
      reviewed: true, passNumber: 1, findingCount: 0, inline: true,
    });
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) => {
          if (q.includes("acme/svc-a")) return Promise.reject(new Error("boom"));
          if (q.includes("acme/svc-b") && !q.includes("in:comments")) return Promise.resolve([42]);
          return Promise.resolve([]);
        }),
        listTriggerComments: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
      runReview,
    });

    const summary = await pollOnce([repoA, repoB], deps);
    expect(summary.autoReviewed).toBe(1);
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, trigger: "auto" }),
    );
    expect(summary.errors).toBeGreaterThan(0);
  });

  it("advances the trigger marker even when runReview rejects, so a permanently-failing PR is not retried forever", async () => {
    const runReview = vi.fn().mockRejectedValue(new Error("boom"));
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [20] : []),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([
          { id: 900, author: "bhanu", createdAt: "2026-01-01", body: "@review-agent review" },
        ]),
        octokit: {} as never,
      },
      runReview,
    });

    const first = await pollOnce([repo], deps);
    expect(first.errors).toBe(1);
    expect(deps.state.lastTriggerCommentId("acme/api#20")).toBe(900);

    await pollOnce([repo], deps);
    expect(runReview).toHaveBeenCalledOnce();
  });

  it("does not call runReview when persisting the trigger id fails, so nothing is posted twice", async () => {
    const runReview = vi.fn().mockResolvedValue({
      reviewed: true, passNumber: 1, findingCount: 0, inline: true,
    });
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [20] : []),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([
          { id: 900, author: "bhanu", createdAt: "2026-01-01", body: "@review-agent review" },
        ]),
        octokit: {} as never,
      },
      runReview,
    });
    vi.spyOn(deps.state, "setLastTriggerCommentId").mockRejectedValueOnce(new Error("disk full"));

    const first = await pollOnce([repo], deps);
    expect(first.errors).toBe(1);
    expect(runReview).not.toHaveBeenCalled();

    const second = await pollOnce([repo], deps);
    expect(second.manualReviewed).toBe(1);
    expect(runReview).toHaveBeenCalledOnce();
  });

  it("reviews a PR only once when it matches both the auto filter and an unprocessed trigger comment in the same cycle", async () => {
    const runReview = vi.fn().mockResolvedValue({
      reviewed: true, passNumber: 1, findingCount: 0, inline: true,
    });
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockResolvedValue([30]),
        listTriggerComments: vi.fn().mockResolvedValue([
          { id: 900, author: "bhanu", createdAt: "2026-01-01", body: "@review-agent review" },
        ]),
        octokit: {} as never,
      },
      runReview,
    });

    const summary = await pollOnce([repo], deps);
    expect(runReview).toHaveBeenCalledOnce();
    expect(summary.autoReviewed).toBe(1);
    expect(summary.manualReviewed).toBe(0);
    expect(deps.state.lastTriggerCommentId("acme/api#30")).toBe(900);
  });

  describe("auto-review failure cap", () => {
    it("stops retrying a PR in the auto pass once it hits the cap", async () => {
      const runReview = vi.fn().mockRejectedValue(new Error("model timeout"));
      const deps = await makeDeps({
        github: {
          searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
            Promise.resolve(q.includes("in:comments") ? [] : [50]),
          ),
          listTriggerComments: vi.fn().mockResolvedValue([]),
          octokit: {} as never,
        },
        runReview,
      });

      for (let i = 0; i < MAX_CONSECUTIVE_AUTO_FAILURES; i++) {
        await pollOnce([repo], deps);
      }
      expect(runReview).toHaveBeenCalledTimes(MAX_CONSECUTIVE_AUTO_FAILURES);
      expect(deps.state.failureCount("acme/api#50")).toBe(MAX_CONSECUTIVE_AUTO_FAILURES);

      // One more cycle: the cap has been reached, so runReview must not be
      // called again — the PR is abandoned by the auto pass.
      const summary = await pollOnce([repo], deps);
      expect(runReview).toHaveBeenCalledTimes(MAX_CONSECUTIVE_AUTO_FAILURES);
      expect(summary.skipped).toBeGreaterThan(0);
    });

    it("logs the abandonment exactly once, not on every subsequent cycle", async () => {
      const runReview = vi.fn().mockRejectedValue(new Error("model timeout"));
      const deps = await makeDeps({
        github: {
          searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
            Promise.resolve(q.includes("in:comments") ? [] : [51]),
          ),
          listTriggerComments: vi.fn().mockResolvedValue([]),
          octokit: {} as never,
        },
        runReview,
      });

      for (let i = 0; i < MAX_CONSECUTIVE_AUTO_FAILURES; i++) {
        await pollOnce([repo], deps);
      }
      const warnCallsAtCap = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(warnCallsAtCap).toBe(1);

      await pollOnce([repo], deps);
      await pollOnce([repo], deps);
      expect((deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(warnCallsAtCap);
    });

    it("clears the failure count for a PR that eventually succeeds", async () => {
      // A real runReview records the pass on state itself (run-review.ts) —
      // the mock here does the same so this test exercises pollOnce's own
      // failure-count bookkeeping against realistic state transitions.
      const runReview = vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockRejectedValueOnce(new Error("boom"))
        .mockImplementationOnce(async ({ deps: d }: { deps: { state: StateStore } }) => {
          await d.state.recordPass("acme/api#52");
          return { reviewed: true, passNumber: 1, findingCount: 0, inline: true };
        });
      const deps = await makeDeps({
        github: {
          searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
            Promise.resolve(q.includes("in:comments") ? [] : [52]),
          ),
          listTriggerComments: vi.fn().mockResolvedValue([]),
          octokit: {} as never,
        },
        runReview,
      });

      await pollOnce([repo], deps);
      await pollOnce([repo], deps);
      expect(deps.state.failureCount("acme/api#52")).toBe(2);

      const summary = await pollOnce([repo], deps);
      expect(summary.autoReviewed).toBe(1);
      expect(deps.state.failureCount("acme/api#52")).toBe(0);
      expect(deps.state.hasBeenReviewed("acme/api#52")).toBe(true);
    });

    it("does not share the failure cap between different PRs", async () => {
      const runReview = vi
        .fn()
        .mockImplementation(
          async ({ prNumber, deps: d }: { prNumber: number; deps: { state: StateStore } }) => {
            if (prNumber === 60) return Promise.reject(new Error("always fails"));
            await d.state.recordPass(`acme/api#${prNumber}`);
            return { reviewed: true, passNumber: 1, findingCount: 0, inline: true };
          },
        );
      const deps = await makeDeps({
        github: {
          searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
            Promise.resolve(q.includes("in:comments") ? [] : [60, 61]),
          ),
          listTriggerComments: vi.fn().mockResolvedValue([]),
          octokit: {} as never,
        },
        runReview,
      });

      for (let i = 0; i < MAX_CONSECUTIVE_AUTO_FAILURES; i++) {
        await pollOnce([repo], deps);
      }
      expect(deps.state.failureCount("acme/api#60")).toBe(MAX_CONSECUTIVE_AUTO_FAILURES);
      // 61 succeeded on its very first attempt and is unaffected by 60's cap.
      expect(deps.state.failureCount("acme/api#61")).toBe(0);
      expect(deps.state.hasBeenReviewed("acme/api#61")).toBe(true);
    });
  });
});
