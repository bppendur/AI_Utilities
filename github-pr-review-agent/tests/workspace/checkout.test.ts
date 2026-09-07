import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAuthEnv,
  buildRemoteUrl,
  createWorkspaceFromRef,
  sanitizeGitError,
} from "../../src/workspace/checkout.js";

const run = promisify(execFile);

let root: string;
let origin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prws-"));
  origin = join(root, "origin");
  await run("git", ["init", "-b", "main", origin]);
  await run("git", ["-C", origin, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", origin, "config", "user.name", "Test"]);
  await writeFile(join(origin, "hello.txt"), "from main\n", "utf8");
  await run("git", ["-C", origin, "add", "."]);
  await run("git", ["-C", origin, "commit", "-m", "initial"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildRemoteUrl", () => {
  it("builds a credential-free clone URL", () => {
    const url = buildRemoteUrl("acme", "api");
    expect(url).toBe("https://github.com/acme/api.git");
    expect(url).not.toContain("@");
    expect(url).not.toContain("ghp_tok");
  });
});

describe("buildAuthEnv", () => {
  it("authenticates via a process-scoped GIT_CONFIG extraheader, never a raw token in plaintext", () => {
    const env = buildAuthEnv("ghp_tok");

    expect(env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(env["GIT_CONFIG_KEY_0"]).toBe("http.https://github.com/.extraheader");

    const value = env["GIT_CONFIG_VALUE_0"];
    expect(value).toBeDefined();
    expect(value?.startsWith("Authorization: Basic ")).toBe(true);
    expect(value).not.toContain("ghp_tok");

    const encoded = value?.slice("Authorization: Basic ".length) ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("x-access-token:ghp_tok");
  });
});

describe("sanitizeGitError", () => {
  it("redacts basic-auth credentials from the error message and preserves the original as cause", () => {
    const remote = "https://x-access-token:ghp_secret123@github.com/o/r.git";
    const original = new Error(`Command failed: git remote add origin ${remote}`);

    const sanitized = sanitizeGitError(original, remote);

    expect(sanitized.message).not.toContain("ghp_secret123");
    expect(sanitized.message).not.toContain("x-access-token");
    expect(sanitized.message).toContain("***");
    expect(sanitized.cause).toBe(original);
  });
});

describe("createWorkspaceFromRef", () => {
  it("checks out the requested ref into an isolated directory", async () => {
    const ws = await createWorkspaceFromRef({
      remote: origin,
      refs: ["main"],
      checkoutRef: "FETCH_HEAD",
      rootDir: join(root, "workspaces"),
      label: "acme-api-1",
    });
    const content = await readFile(join(ws.dir, "hello.txt"), "utf8");
    expect(content).toBe("from main\n");
    await ws.cleanup();
    await expect(access(ws.dir)).rejects.toThrow();
  });

  it("fails loudly when the ref does not exist", async () => {
    await expect(
      createWorkspaceFromRef({
        remote: origin,
        refs: ["does-not-exist"],
        checkoutRef: "FETCH_HEAD",
        rootDir: join(root, "workspaces"),
        label: "acme-api-2",
      }),
    ).rejects.toThrow();
  });

  it("checks out the last fetched ref when several are requested", async () => {
    await run("git", ["-C", origin, "checkout", "-q", "-b", "feature"]);
    await writeFile(join(origin, "hello.txt"), "from feature\n", "utf8");
    await run("git", ["-C", origin, "commit", "-qam", "feature change"]);
    await run("git", ["-C", origin, "checkout", "-q", "main"]);

    const ws = await createWorkspaceFromRef({
      remote: origin,
      refs: ["main", "feature"],
      checkoutRef: "FETCH_HEAD",
      rootDir: join(root, "workspaces"),
      label: "acme-api-3",
    });
    expect(await readFile(join(ws.dir, "hello.txt"), "utf8")).toBe("from feature\n");
    await ws.cleanup();
  });

  it(
    "never leaks the clone token in a failed checkout's error message",
    async () => {
      let caught: unknown;
      try {
        await createWorkspaceFromRef({
          remote: "https://x-access-token:ghp_faketoken@127.0.0.1:1/nope.git",
          refs: ["main"],
          checkoutRef: "FETCH_HEAD",
          rootDir: join(root, "workspaces"),
          label: "acme-api-4",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain("ghp_faketoken");
    },
    15_000,
  );
});
