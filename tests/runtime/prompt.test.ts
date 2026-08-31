import { describe, expect, it } from "vitest";
import type { PullRequestDetails } from "../../src/github/client.js";
import { buildPrompt, loadTemplate, DEFAULT_TEMPLATE_PATH } from "../../src/runtime/prompt.js";

const pr: PullRequestDetails = {
  number: 42,
  title: "Add widget",
  body: "Closes #1",
  author: "octocat",
  headRef: "feature",
  headSha: "abc123",
  baseRef: "main",
  draft: false,
  changedFiles: ["src/a.ts", "src/b.ts"],
  diff: "diff --git a/src/a.ts b/src/a.ts",
};

describe("buildPrompt", () => {
  it("substitutes every placeholder", async () => {
    const template = await loadTemplate(DEFAULT_TEMPLATE_PATH);
    const out = buildPrompt(template, {
      role: "Security reviewer.",
      repoFullName: "acme/api",
      passNumber: 1,
      pr,
      priorReviews: [],
    });
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(out).toContain("Security reviewer.");
    expect(out).toContain("acme/api");
    expect(out).toContain("PR #42: Add widget");
    expect(out).toContain("- src/a.ts");
    expect(out).toContain("diff --git a/src/a.ts");
  });

  it("says there are no prior reviews on the first pass", async () => {
    const template = await loadTemplate(DEFAULT_TEMPLATE_PATH);
    const out = buildPrompt(template, {
      role: "r", repoFullName: "acme/api", passNumber: 1, pr, priorReviews: [],
    });
    expect(out).toContain("This is the first review");
  });

  it("includes prior review bodies on a later pass so it can track resolution", async () => {
    const template = await loadTemplate(DEFAULT_TEMPLATE_PATH);
    const out = buildPrompt(template, {
      role: "r",
      repoFullName: "acme/api",
      passNumber: 2,
      pr,
      priorReviews: [
        { author: "bot", submittedAt: "2026-01-01T00:00:00Z", body: "Null check missing." },
      ],
    });
    expect(out).toContain("pass **2**");
    expect(out).toContain("Null check missing.");
    expect(out).toContain("already been resolved");
  });

  it("substitutes an empty PR body without leaving a hole", async () => {
    const template = await loadTemplate(DEFAULT_TEMPLATE_PATH);
    const out = buildPrompt(template, {
      role: "r", repoFullName: "acme/api", passNumber: 1,
      pr: { ...pr, body: "" }, priorReviews: [],
    });
    expect(out).toContain("(no description provided)");
  });
});
