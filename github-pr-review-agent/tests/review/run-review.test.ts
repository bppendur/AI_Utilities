import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRepo } from "../../src/config/schema.js";
import { runReview } from "../../src/review/run-review.js";
import { StateStore } from "../../src/state/store.js";

const repo: ResolvedRepo = {
  owner: "acme", name: "api", fullName: "acme/api",
  role: "Be thorough.", filter: "draft:false",
};

const prDetails = {
  number: 42, title: "Add widget", body: "b", author: "octocat",
  headRef: "feature", headSha: "abc123", baseRef: "main", draft: false,
  changedFiles: ["src/a.ts"], diff: "diff",
};

const result = {
  summary: "one issue",
  findings: [{ file: "src/a.ts", line: 4, severity: "major" as const, body: "bug" }],
};

let dir: string;

async function makeDeps(overrides: Record<string, unknown> = {}) {
  const cleanup = vi.fn().mockResolvedValue(undefined);
  return {
    cleanup,
    deps: {
      github: {
        getPullRequest: vi.fn().mockResolvedValue(prDetails),
        listPriorReviews: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
      runtime: { name: "claude", review: vi.fn().mockResolvedValue(result) },
      state: await StateStore.open(join(dir, "state.json")),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      template: "ROLE={{ROLE}} DIFF={{DIFF}}",
      token: "ghp_x",
      workspaceRoot: join(dir, "ws"),
      timeoutMs: 1000,
      createWorkspace: vi.fn().mockResolvedValue({ dir: "/ws", cleanup }),
      postReview: vi.fn().mockResolvedValue({ inline: true }),
      ...overrides,
    } as never,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prrun-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runReview", () => {
  it("checks out, reviews, posts and records the pass", async () => {
    const { deps } = await makeDeps();
    const outcome = await runReview({ repo, prNumber: 42, trigger: "auto", deps });
    expect(outcome).toMatchObject({ reviewed: true, passNumber: 1, findingCount: 1, inline: true });
    expect(deps.postReview).toHaveBeenCalledOnce();
    expect(deps.state.hasBeenReviewed("acme/api#42")).toBe(true);
  });

  it("passes the repo role and prior reviews into the prompt", async () => {
    const { deps } = await makeDeps({
      github: {
        getPullRequest: vi.fn().mockResolvedValue(prDetails),
        listPriorReviews: vi.fn().mockResolvedValue([
          { author: "bot", submittedAt: "2026-01-01", body: "earlier point" },
        ]),
        octokit: {} as never,
      },
    });
    await runReview({ repo, prNumber: 42, trigger: "manual", deps });
    const prompt = (deps.runtime.review as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt;
    expect(prompt).toContain("Be thorough.");
  });

  it("always cleans up the workspace, even when the runtime throws", async () => {
    const { deps, cleanup } = await makeDeps({
      runtime: { name: "claude", review: vi.fn().mockRejectedValue(new Error("model failed")) },
    });
    await expect(runReview({ repo, prNumber: 42, trigger: "auto", deps })).rejects.toThrow(
      "model failed",
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not record a pass when posting fails, so the PR is retried", async () => {
    const { deps } = await makeDeps({
      postReview: vi.fn().mockRejectedValue(new Error("network")),
    });
    await expect(runReview({ repo, prNumber: 42, trigger: "auto", deps })).rejects.toThrow(
      "network",
    );
    expect(deps.state.hasBeenReviewed("acme/api#42")).toBe(false);
  });

  it("skips an auto review of a draft PR but allows a manual one", async () => {
    const draft = { ...prDetails, draft: true };
    const { deps } = await makeDeps({
      github: {
        getPullRequest: vi.fn().mockResolvedValue(draft),
        listPriorReviews: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
    });
    const auto = await runReview({ repo, prNumber: 42, trigger: "auto", deps });
    expect(auto).toMatchObject({ reviewed: false, skippedReason: "draft" });
    expect(deps.postReview).not.toHaveBeenCalled();

    const manual = await runReview({ repo, prNumber: 42, trigger: "manual", deps });
    expect(manual.reviewed).toBe(true);
  });
});
