import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig, resolveRepos } from "../src/config/schema.js";
import { loadConfig } from "../src/config/load.js";

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

describe("loadConfig", () => {
  const savedEnv = {
    POLL_INTERVAL_MINUTES: process.env.POLL_INTERVAL_MINUTES,
    TRIGGER_PHRASE: process.env.TRIGGER_PHRASE,
  };

  afterEach(() => {
    delete process.env.POLL_INTERVAL_MINUTES;
    delete process.env.TRIGGER_PHRASE;
    if (savedEnv.POLL_INTERVAL_MINUTES !== undefined) {
      process.env.POLL_INTERVAL_MINUTES = savedEnv.POLL_INTERVAL_MINUTES;
    }
    if (savedEnv.TRIGGER_PHRASE !== undefined) {
      process.env.TRIGGER_PHRASE = savedEnv.TRIGGER_PHRASE;
    }
  });

  it("loads and parses a valid YAML config file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pr-review-agent-test-"));
    try {
      const configPath = join(tempDir, "config.yaml");
      const yamlContent = `
defaults:
  role: "You are a reviewer."
  filter: "draft:false"
repos:
  - repo: "acme/api"
`;
      writeFileSync(configPath, yamlContent);

      const cfg = await loadConfig(configPath);
      expect(cfg.runtime).toBe("claude");
      expect(cfg.pollIntervalMinutes).toBe(10);
      expect(cfg.triggerPhrase).toBe("@review-agent review");
      expect(cfg.defaults.role).toBe("You are a reviewer.");
      expect(cfg.defaults.filter).toBe("draft:false");
      expect(cfg.repos).toHaveLength(1);
      expect(cfg.repos[0]!.repo).toBe("acme/api");
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("throws when file does not exist", async () => {
    const nonexistentPath = join(tmpdir(), "nonexistent-config-12345.yaml");
    await expect(loadConfig(nonexistentPath)).rejects.toThrow(
      /Config file not found or unreadable/,
    );
  });

  it("overrides poll interval when POLL_INTERVAL_MINUTES env var is set", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pr-review-agent-test-"));
    try {
      process.env.POLL_INTERVAL_MINUTES = "30";
      const configPath = join(tempDir, "config.yaml");
      const yamlContent = `
defaults:
  role: "You are a reviewer."
  filter: "draft:false"
repos:
  - repo: "acme/api"
pollIntervalMinutes: 10
`;
      writeFileSync(configPath, yamlContent);

      const cfg = await loadConfig(configPath);
      expect(cfg.pollIntervalMinutes).toBe(30);
    } finally {
      rmSync(tempDir, { recursive: true });
      delete process.env.POLL_INTERVAL_MINUTES;
    }
  });

  it("throws when POLL_INTERVAL_MINUTES env var is invalid", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pr-review-agent-test-"));
    try {
      process.env.POLL_INTERVAL_MINUTES = "abc";
      const configPath = join(tempDir, "config.yaml");
      const yamlContent = `
defaults:
  role: "You are a reviewer."
  filter: "draft:false"
repos:
  - repo: "acme/api"
`;
      writeFileSync(configPath, yamlContent);

      await expect(loadConfig(configPath)).rejects.toThrow(
        /POLL_INTERVAL_MINUTES must be a positive integer/,
      );
    } finally {
      rmSync(tempDir, { recursive: true });
      delete process.env.POLL_INTERVAL_MINUTES;
    }
  });

  it("throws when POLL_INTERVAL_MINUTES env var is zero or negative", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pr-review-agent-test-"));
    try {
      process.env.POLL_INTERVAL_MINUTES = "0";
      const configPath = join(tempDir, "config.yaml");
      const yamlContent = `
defaults:
  role: "You are a reviewer."
  filter: "draft:false"
repos:
  - repo: "acme/api"
`;
      writeFileSync(configPath, yamlContent);

      await expect(loadConfig(configPath)).rejects.toThrow(
        /POLL_INTERVAL_MINUTES must be a positive integer/,
      );
    } finally {
      rmSync(tempDir, { recursive: true });
      delete process.env.POLL_INTERVAL_MINUTES;
    }
  });

  it("overrides trigger phrase when TRIGGER_PHRASE env var is set", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pr-review-agent-test-"));
    try {
      process.env.TRIGGER_PHRASE = "@bot review this";
      const configPath = join(tempDir, "config.yaml");
      const yamlContent = `
defaults:
  role: "You are a reviewer."
  filter: "draft:false"
repos:
  - repo: "acme/api"
triggerPhrase: "@review-agent review"
`;
      writeFileSync(configPath, yamlContent);

      const cfg = await loadConfig(configPath);
      expect(cfg.triggerPhrase).toBe("@bot review this");
    } finally {
      rmSync(tempDir, { recursive: true });
      delete process.env.TRIGGER_PHRASE;
    }
  });
});
