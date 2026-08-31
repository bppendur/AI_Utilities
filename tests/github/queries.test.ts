import { describe, expect, it } from "vitest";
import type { ResolvedRepo } from "../../src/config/schema.js";
import { buildAutoQuery, buildTriggerQuery } from "../../src/github/queries.js";

const repo: ResolvedRepo = {
  owner: "acme",
  name: "api",
  fullName: "acme/api",
  role: "reviewer",
  filter: "draft:false -author:dependabot[bot]",
};

describe("buildAutoQuery", () => {
  it("scopes to the repo and to open PRs, then appends the raw filter", () => {
    expect(buildAutoQuery(repo)).toBe(
      "repo:acme/api is:pr is:open draft:false -author:dependabot[bot]",
    );
  });

  it("omits trailing whitespace when the filter is empty", () => {
    expect(buildAutoQuery({ ...repo, filter: "" })).toBe("repo:acme/api is:pr is:open");
  });
});

describe("buildTriggerQuery", () => {
  it("searches comments for the quoted trigger phrase and ignores the filter", () => {
    expect(buildTriggerQuery(repo, "@review-agent review")).toBe(
      'repo:acme/api is:pr is:open "@review-agent review" in:comments',
    );
  });

  it("escapes double quotes inside the trigger phrase", () => {
    expect(buildTriggerQuery(repo, 'say "hi"')).toBe(
      'repo:acme/api is:pr is:open "say \\"hi\\"" in:comments',
    );
  });
});
