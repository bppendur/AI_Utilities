import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../../src/github/client.js";

const ref = { owner: "acme", repo: "api", number: 42 };

function fakeOctokit(overrides: Record<string, unknown> = {}) {
  return {
    rest: {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: { items: [{ number: 42 }, { number: 43 }] },
        }),
      },
      pulls: {
        get: vi.fn().mockImplementation(({ mediaType }) =>
          mediaType?.format === "diff"
            ? Promise.resolve({ data: "diff --git a/x b/x" })
            : Promise.resolve({
                data: {
                  number: 42,
                  title: "Add widget",
                  body: "Closes #1",
                  user: { login: "octocat" },
                  head: { ref: "feature", sha: "abc123" },
                  base: { ref: "main" },
                  draft: false,
                },
              }),
        ),
        listFiles: vi.fn().mockResolvedValue({
          data: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
        }),
        listReviews: vi.fn().mockResolvedValue({
          data: [
            { user: { login: "octocat" }, submitted_at: "2026-01-01T00:00:00Z", body: "looks ok" },
            { user: { login: "octocat" }, submitted_at: "2026-01-02T00:00:00Z", body: "" },
          ],
        }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: [
            { id: 1, user: { login: "bhanu" }, created_at: "2026-01-01T00:00:00Z", body: "nice work" },
            { id: 2, user: { login: "bhanu" }, created_at: "2026-01-02T00:00:00Z", body: "@review-agent review please" },
          ],
        }),
      },
    },
    ...overrides,
  };
}

describe("GitHubClient", () => {
  it("returns PR numbers from a search query", async () => {
    const octo = fakeOctokit();
    const client = new GitHubClient(octo as never);
    await expect(client.searchPullRequestNumbers("repo:acme/api is:pr")).resolves.toEqual([42, 43]);
    expect(octo.rest.search.issuesAndPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ q: "repo:acme/api is:pr", per_page: 100 }),
    );
  });

  it("assembles PR details including changed files and the raw diff", async () => {
    const client = new GitHubClient(fakeOctokit() as never);
    const pr = await client.getPullRequest(ref);
    expect(pr).toMatchObject({
      number: 42,
      title: "Add widget",
      author: "octocat",
      headRef: "feature",
      headSha: "abc123",
      baseRef: "main",
      draft: false,
      changedFiles: ["src/a.ts", "src/b.ts"],
      diff: "diff --git a/x b/x",
    });
  });

  it("returns only comments containing the trigger phrase", async () => {
    const client = new GitHubClient(fakeOctokit() as never);
    const comments = await client.listTriggerComments(ref, "@review-agent review");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: 2, author: "bhanu" });
  });

  it("drops prior reviews that carry no body text", async () => {
    const client = new GitHubClient(fakeOctokit() as never);
    const reviews = await client.listPriorReviews(ref);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body).toBe("looks ok");
  });

  it("truncates an oversized diff and says so", async () => {
    const octo = fakeOctokit();
    octo.rest.pulls.get = vi.fn().mockImplementation(({ mediaType }) =>
      mediaType?.format === "diff"
        ? Promise.resolve({ data: "x".repeat(300_000) })
        : Promise.resolve({
            data: {
              number: 42, title: "t", body: "", user: { login: "u" },
              head: { ref: "f", sha: "s" }, base: { ref: "main" }, draft: false,
            },
          }),
    );
    const client = new GitHubClient(octo as never);
    const pr = await client.getPullRequest(ref);
    expect(pr.diff.length).toBeLessThan(300_000);
    expect(pr.diff).toContain("[diff truncated]");
  });
});
