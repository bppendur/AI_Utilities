import { describe, expect, it, vi } from "vitest";
import { createLogger, redact } from "../src/logger.js";

describe("redact", () => {
  it("replaces every occurrence of each secret", () => {
    const out = redact("token=ghp_abc123 and again ghp_abc123", ["ghp_abc123"]);
    expect(out).toBe("token=*** and again ***");
  });

  it("ignores empty or short secrets so it cannot blank the whole message", () => {
    expect(redact("hello", ["", "a"])).toBe("hello");
  });
});

describe("createLogger", () => {
  it("prefixes the logger name and level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger("poller").info("cycle start");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain("[INFO]");
    expect(spy.mock.calls[0]![0]).toContain("[poller]");
    expect(spy.mock.calls[0]![0]).toContain("cycle start");
    spy.mockRestore();
  });

  it("redacts registered secrets from the message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("gh", { secrets: ["ghp_supersecret"] });
    log.info("cloning https://ghp_supersecret@github.com/o/r");
    expect(spy.mock.calls[0]![0]).not.toContain("ghp_supersecret");
    spy.mockRestore();
  });
});
