import { describe, expect, it, vi } from "vitest";
import { createLogger, errorMessage, redact } from "../src/logger.js";

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

  it("routes error and warn to stderr, not stdout", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("agent");

    log.error("something broke");
    log.warn("heads up");
    log.info("all fine");

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0]![0]).toContain("[ERROR]");
    expect(errorSpy.mock.calls[0]![0]).toContain("something broke");
    expect(errorSpy.mock.calls[1]![0]).toContain("[WARN]");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toContain("[INFO]");

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("errorMessage", () => {
  it("returns the message of a real Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a thrown string as-is", () => {
    expect(errorMessage("plain string failure")).toBe("plain string failure");
  });

  it("never returns 'undefined' for a non-Error rejection", () => {
    expect(errorMessage({ code: "ENOENT" })).not.toBe("undefined");
    expect(errorMessage(42)).not.toBe("undefined");
    expect(errorMessage(null)).not.toBe("undefined");
  });
});
