import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prKey, StateStore } from "../src/state/store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prstate-"));
  file = join(dir, "nested", "state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("starts empty when the file does not exist yet", async () => {
    const store = await StateStore.open(file);
    expect(store.hasBeenReviewed(prKey("acme/api", 1))).toBe(false);
    expect(store.passCount(prKey("acme/api", 1))).toBe(0);
  });

  it("records passes with an increasing 1-based pass number", async () => {
    const store = await StateStore.open(file);
    const key = prKey("acme/api", 7);
    expect(await store.recordPass(key)).toBe(1);
    expect(await store.recordPass(key)).toBe(2);
    expect(store.hasBeenReviewed(key)).toBe(true);
  });

  it("survives a reopen so restarts do not double-review", async () => {
    const key = prKey("acme/api", 7);
    const first = await StateStore.open(file);
    await first.recordPass(key);
    const second = await StateStore.open(file);
    expect(second.hasBeenReviewed(key)).toBe(true);
    expect(second.passCount(key)).toBe(1);
  });

  it("tracks the last processed trigger comment id per PR", async () => {
    const store = await StateStore.open(file);
    const key = prKey("acme/api", 9);
    expect(store.lastTriggerCommentId(key)).toBe(0);
    await store.setLastTriggerCommentId(key, 555);
    expect(store.lastTriggerCommentId(key)).toBe(555);
    const reopened = await StateStore.open(file);
    expect(reopened.lastTriggerCommentId(key)).toBe(555);
  });

  it("treats a corrupt state file as empty rather than crashing the service", async () => {
    const store = await StateStore.open(file);
    await store.recordPass(prKey("acme/api", 1));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ not json", "utf8");
    const reopened = await StateStore.open(file);
    expect(reopened.hasBeenReviewed(prKey("acme/api", 1))).toBe(false);
  });

  it("drops a malformed per-entry state instead of computing NaN and looping forever", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        prs: {
          "acme/api#1": { passes: "not-a-number", lastTriggerCommentId: 0 },
          "acme/api#2": { passes: 2, lastTriggerCommentId: 0 },
        },
      }),
      "utf8",
    );
    const store = await StateStore.open(file);
    // Malformed entry dropped — treated as never-reviewed, not stuck forever.
    expect(store.hasBeenReviewed(prKey("acme/api", 1))).toBe(false);
    expect(store.passCount(prKey("acme/api", 1))).toBe(0);
    // Well-shaped entry alongside it is unaffected.
    expect(store.hasBeenReviewed(prKey("acme/api", 2))).toBe(true);
  });

  describe("consecutive auto-review failures", () => {
    it("increments the failure count per key", async () => {
      const store = await StateStore.open(file);
      const key = prKey("acme/api", 3);
      expect(store.failureCount(key)).toBe(0);
      expect(await store.recordFailure(key)).toBe(1);
      expect(await store.recordFailure(key)).toBe(2);
      expect(store.failureCount(key)).toBe(2);
    });

    it("clears the failure count on a successful pass", async () => {
      const store = await StateStore.open(file);
      const key = prKey("acme/api", 4);
      await store.recordFailure(key);
      await store.recordFailure(key);
      expect(store.failureCount(key)).toBe(2);
      await store.recordPass(key);
      expect(store.failureCount(key)).toBe(0);
    });

    it("tracks failures independently per PR key", async () => {
      const store = await StateStore.open(file);
      const keyA = prKey("acme/api", 5);
      const keyB = prKey("acme/api", 6);
      await store.recordFailure(keyA);
      await store.recordFailure(keyA);
      await store.recordFailure(keyA);
      expect(store.failureCount(keyA)).toBe(3);
      expect(store.failureCount(keyB)).toBe(0);
    });

    it("survives a reopen", async () => {
      const key = prKey("acme/api", 7);
      const first = await StateStore.open(file);
      await first.recordFailure(key);
      await first.recordFailure(key);
      const reopened = await StateStore.open(file);
      expect(reopened.failureCount(key)).toBe(2);
    });
  });
});
