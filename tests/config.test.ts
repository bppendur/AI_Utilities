import { describe, expect, it } from "vitest";
import { parseConfig, resolveRepos } from "../src/config/schema.js";

const minimal = {
  defaults: { role: "You are a reviewer.", filter: "draft:false" },
  repos: [{ repo: "acme/api" }],
};

describe("parseConfig", () => {
  it("applies defaults for runtime, interval and trigger phrase", () => {
    const cfg = parseConfig(minimal);
    expect(cfg.runtime).toBe("claude");
    expect(cfg.pollIntervalMinutes).toBe(10);
    expect(cfg.triggerPhrase).toBe("@review-agent review");
  });

  it("rejects an unknown runtime", () => {
    expect(() => parseConfig({ ...minimal, runtime: "gemini" })).toThrow();
  });

  it("rejects a repo that is not owner/name", () => {
    expect(() => parseConfig({ ...minimal, repos: [{ repo: "acme" }] })).toThrow(
      /owner\/name/,
    );
  });

  it("rejects an empty repo list", () => {
    expect(() => parseConfig({ ...minimal, repos: [] })).toThrow();
  });
});

describe("resolveRepos", () => {
  it("falls back to the shared defaults when a repo overrides nothing", () => {
    const [repo] = resolveRepos(parseConfig(minimal));
    expect(repo).toEqual({
      owner: "acme",
      name: "api",
      fullName: "acme/api",
      role: "You are a reviewer.",
      filter: "draft:false",
    });
  });

  it("lets a repo fully replace role and filter", () => {
    const cfg = parseConfig({
      ...minimal,
      repos: [{ repo: "acme/web", role: "Security reviewer.", filter: "base:main" }],
    });
    const [repo] = resolveRepos(cfg);
    expect(repo!.role).toBe("Security reviewer.");
    expect(repo!.filter).toBe("base:main");
  });
});
