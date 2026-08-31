import { describe, expect, it, vi } from "vitest";
import { postReview } from "../../src/github/post-review.js";
import type { ReviewResult } from "../../src/runtime/types.js";

const ref = { owner: "acme", repo: "api", number: 42 };
const result: ReviewResult = {
  summary: "Two issues found.",
  findings: [
    { file: "src/a.ts", line: 10, severity: "major", body: "Unhandled null." },
    { file: "src/b.ts", line: 3, severity: "nit", body: "Rename this." },
  ],
};

describe("postReview", () => {
  it("always submits with event COMMENT and never approves", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: {} });
    const octo = { rest: { pulls: { createReview } } };
    await postReview(octo as never, ref, "abc123", result);
    const args = createReview.mock.calls[0]![0];
    expect(args.event).toBe("COMMENT");
    expect(args.commit_id).toBe("abc123");
    expect(args.comments).toHaveLength(2);
    expect(args.comments[0]).toMatchObject({ path: "src/a.ts", line: 10, side: "RIGHT" });
    expect(args.comments[0].body).toContain("**MAJOR**");
  });

  it("falls back to a summary-only review when GitHub rejects the inline positions", async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Unprocessable"), { status: 422 }))
      .mockResolvedValueOnce({ data: {} });
    const octo = { rest: { pulls: { createReview } } };
    const outcome = await postReview(octo as never, ref, "abc123", result);
    expect(outcome.inline).toBe(false);
    expect(createReview).toHaveBeenCalledTimes(2);
    const fallback = createReview.mock.calls[1]![0];
    expect(fallback.comments).toBeUndefined();
    expect(fallback.event).toBe("COMMENT");
    expect(fallback.body).toContain("src/a.ts:10");
    expect(fallback.body).toContain("Unhandled null.");
  });

  it("posts a summary-only review when there are no findings", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: {} });
    const octo = { rest: { pulls: { createReview } } };
    await postReview(octo as never, ref, "abc123", { summary: "All clear.", findings: [] });
    const args = createReview.mock.calls[0]![0];
    expect(args.comments).toBeUndefined();
    expect(args.event).toBe("COMMENT");
  });

  it("rethrows non-422 errors instead of silently degrading", async () => {
    const createReview = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const octo = { rest: { pulls: { createReview } } };
    await expect(postReview(octo as never, ref, "abc123", result)).rejects.toThrow("boom");
    expect(createReview).toHaveBeenCalledTimes(1);
  });
});
