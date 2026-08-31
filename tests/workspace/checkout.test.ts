import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCloneUrl, createWorkspaceFromRef } from "../../src/workspace/checkout.js";

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

describe("buildCloneUrl", () => {
  it("embeds the token as basic auth so git can fetch private repos", () => {
    expect(buildCloneUrl("acme", "api", "ghp_tok")).toBe(
      "https://x-access-token:ghp_tok@github.com/acme/api.git",
    );
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
});
