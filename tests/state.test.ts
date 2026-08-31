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
});
