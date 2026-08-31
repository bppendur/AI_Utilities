import { describe, expect, it, vi } from "vitest";
import { buildProgram, parsePrNumber, runLoop } from "../src/cli.js";

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

  it("does not accumulate abort listeners across cycles that resolve normally", async () => {
    // Regression guard for the sleep() listener leak: a poll cycle that
    // resolves via its timer (the common, non-aborted path) must remove
    // the "abort" listener it registered, not just the one that fires when
    // the signal actually aborts. Otherwise the same long-lived
    // AbortSignal (one AbortController for the daemon's whole lifetime)
    // accumulates a listener per cycle, unboundedly.
    const controller = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const addSpy = vi
      .spyOn(controller.signal, "addEventListener")
      .mockImplementation((...args) => {
        addCount += 1;
        return AbortSignal.prototype.addEventListener.apply(controller.signal, args as never);
      });
    const removeSpy = vi
      .spyOn(controller.signal, "removeEventListener")
      .mockImplementation((...args) => {
        removeCount += 1;
        return AbortSignal.prototype.removeEventListener.apply(controller.signal, args as never);
      });

    let calls = 0;
    const poll = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls >= 5) controller.abort();
      return { autoReviewed: 0, manualReviewed: 0, skipped: 0, errors: 0 };
    });
    await runLoop({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never, [], {
      intervalMs: 1,
      signal: controller.signal,
      poll,
    });

    expect(calls).toBe(5);
    // Every add on a normally-resolved cycle must be paired with a remove.
    // (The final, aborted cycle's listener is removed by the abort firing
    // itself via { once: true }, so add/remove stay equal either way.)
    expect(addCount).toBeGreaterThan(0);
    expect(removeCount).toBe(addCount);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

describe("parsePrNumber", () => {
  it("parses a plain digit string", () => {
    expect(parsePrNumber("42")).toBe(42);
  });

  it("rejects a value with trailing non-digit characters", () => {
    expect(() => parsePrNumber("12abc")).toThrow(/--pr must be a number, got: 12abc/);
  });

  it("rejects a non-numeric value", () => {
    expect(() => parsePrNumber("not-a-number")).toThrow(/--pr must be a number/);
  });
});
