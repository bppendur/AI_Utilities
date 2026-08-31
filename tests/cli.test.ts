import { describe, expect, it, vi } from "vitest";
import { buildProgram, runLoop } from "../src/cli.js";

describe("buildProgram", () => {
  it("exposes run, poll-once and review commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["run", "poll-once", "review"]));
  });

  it("requires --repo and --pr on the review command", () => {
    const review = buildProgram().commands.find((c) => c.name() === "review")!;
    const flags = review.options.map((o) => o.flags).join(" ");
    expect(flags).toContain("--repo");
    expect(flags).toContain("--pr");
  });
});

describe("runLoop", () => {
  it("polls repeatedly until aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const poll = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls >= 3) controller.abort();
      return { autoReviewed: 0, manualReviewed: 0, skipped: 0, errors: 0 };
    });
    await runLoop({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never, [], {
      intervalMs: 1,
      signal: controller.signal,
      poll,
    });
    expect(calls).toBe(3);
  });

  it("keeps looping after a poll cycle throws", async () => {
    const controller = new AbortController();
    let calls = 0;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const poll = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls >= 2) controller.abort();
      throw new Error("cycle blew up");
    });
    await runLoop({ logger } as never, [], { intervalMs: 1, signal: controller.signal, poll });
    expect(calls).toBe(2);
    expect(logger.error).toHaveBeenCalled();
  });
});
